import { In } from "typeorm";
import {
  Account,
  AnalyticsDayData,
  Bid,
  Count,
  Data,
  ENS,
  Estate,
  NFT,
  Order,
  Parcel,
  Wearable,
  Network as ModelNetwork,
  Item,
  Collection,
  Metadata,
} from "../model";
import { Context } from "./processor";
import { getAddresses } from "../common/utils/addresses";
import { Network } from "@dcl/schemas";
import { EthereumInMemoryState } from "./types";
import { findInChunks } from "../common/utils/store";

export const getStoredData = async (
  ctx: Context,
  ids: Pick<
    EthereumInMemoryState,
    | "accountIds"
    | "landTokenIds"
    | "estateTokenIds"
    | "ensTokenIds"
    | "tokenIds"
    | "analyticsIds"
    | "bidIds"
    | "collectionIds"
    | "itemIds"
  >
) => {
  const {
    accountIds,
    ensTokenIds,
    estateTokenIds,
    landTokenIds,
    tokenIds,
    analyticsIds,
    bidIds,
    collectionIds,
    itemIds,
  } = ids;

  const accountIdsToLookFor = [...accountIds].map(
    (id) => `${id}-${ModelNetwork.ETHEREUM}`
  );
  // console.log("accountIdsToLookFor: ", accountIdsToLookFor);

  const accounts = await findInChunks(accountIdsToLookFor, (chunk) =>
    ctx.store.findBy(Account, {
      id: In(chunk),
      network: ModelNetwork.ETHEREUM,
    })
  )
    .then((q) => new Map(q.map((i) => [i.id, i])));
  // console.log("accounts: ", accounts);

  const parcels = await findInChunks([...landTokenIds], (chunk) =>
    ctx.store.findBy(Parcel, { tokenId: In(chunk) })
  )
    .then((q) => new Map(q.map((i) => [i.id, i])));

  const estates = await findInChunks([...estateTokenIds], (chunk) =>
    ctx.store.findBy(Estate, { tokenId: In(chunk) })
  )
    .then((q) => new Map(q.map((i) => [i.id, i])));

  const addresses = getAddresses(Network.ETHEREUM);

  // grab ids from all nfts to query
  const nftIds = [
    ...Array.from(estates.values()).map(
      (e) => `estate-${addresses.EstateRegistry}-${e.tokenId}`
    ),
    ...Array.from(parcels.values()).map(
      (p) => `parcel-${addresses.LANDRegistry}-${p.tokenId}`
    ),
    // ...Array.from(tokenIds.entries())
    //   .map(([contractAddress, tokenId]) =>
    //     tokenId.map((id) => `wearable-${contractAddress}-${id}`)
    //   )
    //   .flat(),
    ...Array.from(tokenIds.entries()) // for the NFTs created by the handleTransferWearableV1 that won't have the prefix added
      .map(([contractAddress, tokenId]) =>
        tokenId.map((id) => `${contractAddress}-${id}`)
      )
      .flat(),
    ...Array.from(ensTokenIds.values()).map(
      (tokenId) => `ens-${addresses.DCLRegistrar}-${tokenId}`
    ),
  ];

  const nfts = await findInChunks(nftIds, (chunk) =>
    ctx.store.find(NFT, {
      relations: {
        owner: true,
        activeOrder: true,
        metadata: true,
        item: true,
      },
      where: {
        id: In(chunk),
        network: ModelNetwork.ETHEREUM,
      },
    })
  )
    .then((q) => new Map(q.map((i) => [i.id, i])));

  const orders = await findInChunks(nftIds, (chunk) =>
    ctx.store.findBy(Order, {
      nft: In(chunk),
      network: ModelNetwork.ETHEREUM,
      // id: In([...Array.from(nfts.values()).map((nft) => nft.activeOrder)]), // @TODO, revisit this
    })
  )
    .then((q) => new Map(q.map((i) => [i.id, i])));

  const datas = await Promise.all([
    findInChunks([...estateTokenIds], (chunk) =>
      ctx.store.find(Data, { where: { estate: In(chunk) } })
    ),
    findInChunks([...landTokenIds], (chunk) =>
      ctx.store.find(Data, { where: { parcel: In(chunk) } })
    ),
  ])
    .then((found) => found.flat())
    .then((q) => new Map(q.map((i) => [i.id, i])));

  const wearablesIds: string[] = [];
  Array.from(tokenIds.entries()).forEach(([contractAddress, tokenId]) => {
    for (const id of tokenId) {
      wearablesIds.push(`wearable-${contractAddress}-${id}`);
    }
  });

  const wearables = await findInChunks(wearablesIds, (chunk) =>
    ctx.store.findBy(Wearable, {
      id: In(chunk),
      network: ModelNetwork.ETHEREUM,
    })
  )
    .then((q) => new Map(q.map((i) => [i.id, i])));

  const ens = await findInChunks([...ensTokenIds], (chunk) =>
    ctx.store.findBy(ENS, {
      tokenId: In(chunk),
    })
  )
    .then((q) => new Map(q.map((i) => [i.id, i])));

  const analytics = await findInChunks([...analyticsIds], (chunk) =>
    ctx.store.findBy(AnalyticsDayData, {
      id: In(chunk),
      network: ModelNetwork.ETHEREUM,
    })
  )
    .then((q) => new Map(q.map((i) => [i.id, i])));

  const counts = await ctx.store
    .findBy(Count, {
      network: ModelNetwork.ETHEREUM,
    })
    .then((q) => new Map(q.map((i) => [i.id, i])));

  const bids = await findInChunks([...bidIds], (chunk) =>
    ctx.store.find(Bid, {
      relations: {
        nft: true,
      },
      where: {
        id: In(chunk),
        network: ModelNetwork.ETHEREUM,
      },
    })
  )
    .then((q) => new Map(q.map((i) => [i.id, i])));

  const collections = await findInChunks([...collectionIds], (chunk) =>
    ctx.store.find(Collection, {
      where: {
        network: ModelNetwork.ETHEREUM,
        id: In(chunk),
      },
    })
  )
    .then((q) => new Map(q.map((i) => [i.id, i])));

  const metadataIds = [
    ...Array.from(itemIds.values())
      .map((tokenIds) => tokenIds.map((id) => id.split("-")[1]))
      .flat(),
  ];

  const metadatas = await findInChunks(metadataIds, (chunk) =>
    ctx.store.find(Metadata, {
      relations: {
        emote: true,
        wearable: true,
      },
      where: {
        network: ModelNetwork.ETHEREUM,
        id: In(chunk),
      },
    })
  )
    .then((q) => new Map(q.map((i) => [i.id, i])));

  const itemRelations = { collection: true, metadata: true };
  const items = await Promise.all([
    findInChunks([...collectionIds], (chunk) =>
      ctx.store.find(Item, {
        relations: itemRelations,
        where: { collection: In(chunk), network: ModelNetwork.ETHEREUM },
      })
    ),
    findInChunks([...itemIds.values()].flat(), (chunk) =>
      ctx.store.find(Item, {
        relations: itemRelations,
        where: { id: In(chunk), network: ModelNetwork.ETHEREUM },
      })
    ),
  ])
    .then((found) => found.flat())
    .then((q) => new Map(q.map((i) => [i.id, i])));

  return {
    parcels,
    estates,
    ens,
    datas,
    accounts,
    nfts,
    orders,
    wearables,
    analytics,
    counts,
    bids,
    items,
    collections,
    metadatas,
  };
};
