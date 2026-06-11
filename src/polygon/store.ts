import { In } from "typeorm";
import {
  Account,
  AnalyticsDayData,
  Bid,
  Count,
  NFT,
  Order,
  Wearable,
  Network as ModelNetwork,
  Collection,
  Item,
  Rarity,
  Metadata,
  Emote,
  ItemsDayData,
  AccountsDayData,
} from "../model";
import { Context } from "./processor";
import { PolygonInMemoryState, PolygonStoredData } from "./types";

export const getStoredData = async (
  ctx: Context,
  ids: Pick<
    PolygonInMemoryState,
    | "accountIds"
    | "tokenIds"
    | "analyticsIds"
    | "bidIds"
    | "collectionIds"
    | "itemIds"
    | "itemDayDataIds"
  >
): Promise<PolygonStoredData> => {
  const { accountIds, tokenIds, analyticsIds, bidIds, collectionIds, itemIds, itemDayDataIds } =
    ids;

  // grab ids from all nfts to query
  const nftIds = [
    ...Array.from(tokenIds.entries())
      .map(([contractAddress, tokenId]) =>
        tokenId.map((id) => `${contractAddress}-${id}`)
      )
      .flat(),
  ];

  const itemIdsFlat = [
    ...Array.from(itemIds.entries())
      .map(([contractAddress, itemIds]) =>
        itemIds.map((id) => `${contractAddress}-${id}`)
      )
      .flat(),
  ];

  const metadataIds = [
    ...Array.from(itemIds.entries())
      .map(([contractAddress, tokenId]) =>
        tokenId.map((id) => `${contractAddress}-${id}`)
      )
      .flat(),
  ];

  // ⚡ OPTIMIZATION: Parallelize ALL independent DB queries
  const [
    nfts,
    analytics,
    itemDayDatas,
    accountsDayDatas,
    counts,
    collections,
    bids,
    rarities,
    wearables,
    emotes,
    metadatas,
  ] = await Promise.all([
    // NFTs with relations
    ctx.store
      .find(NFT, {
        relations: {
          owner: true,
          activeOrder: true,
          metadata: true,
          item: true,
        },
        where: {
          id: In(nftIds),
          network: ModelNetwork.POLYGON,
        },
      })
      .then((q) => new Map(q.map((i) => [i.id, i]))),

    // Analytics
    ctx.store
      .findBy(AnalyticsDayData, {
        id: In([...Array.from(analyticsIds.values())]),
        network: ModelNetwork.POLYGON,
      })
      .then((q) => new Map(q.map((i) => [i.id, i]))),

    // ItemDayDatas
    ctx.store
      .findBy(ItemsDayData, {
        id: In([...Array.from(itemDayDataIds.values())]),
      })
      .then((q) => new Map(q.map((i) => [i.id, i]))),

    // AccountsDayDatas
    ctx.store
      .findBy(AccountsDayData, {
        id: In([...Array.from(analyticsIds.values())]),
      })
      .then((q) => new Map(q.map((i) => [i.id, i]))),

    // Counts
    ctx.store
      .find(Count, {
        where: {
          network: ModelNetwork.POLYGON,
        },
      })
      .then((q) => new Map(q.map((i) => [i.id, i]))),

    // Collections
    ctx.store
      .find(Collection, {
        where: {
          network: ModelNetwork.POLYGON,
          id: In([...collectionIds]),
        },
      })
      .then((q) => new Map(q.map((i) => [i.id, i]))),

    // Bids
    ctx.store
      .find(Bid, {
        relations: {
          nft: true,
        },
        where: {
          id: In([...Array.from(bidIds.values())]),
          network: ModelNetwork.POLYGON,
        },
      })
      .then((q) => new Map(q.map((i) => [i.id, i]))),

    // Rarities
    ctx.store.find(Rarity).then((q) => new Map(q.map((i) => [i.id, i]))),

    // Wearables
    ctx.store
      .find(Wearable, {
        where: {
          id: In([...itemIds]),
          network: ModelNetwork.POLYGON,
        },
      })
      .then((q) => new Map(q.map((i) => [i.id, i]))),

    // Emotes
    ctx.store
      .find(Emote, {
        where: {
          id: In([...itemIds]),
        },
      })
      .then((q) => new Map(q.map((i) => [i.id, i]))),

    // Metadatas
    ctx.store
      .find(Metadata, {
        relations: {
          emote: true,
          wearable: true,
        },
        where: {
          network: ModelNetwork.POLYGON,
          id: In([...metadataIds]),
        },
      })
      .then((q) => new Map(q.map((i) => [i.id, i]))),
  ]);

  // These queries depend on NFTs result
  const nftItemIds = Array.from(nfts.values()).map((nft) => nft.item?.id);

  // ⚡ OPTIMIZATION: Second batch of parallel queries (depend on first batch)
  const [orders, items] = await Promise.all([
    // Orders (depends on nftIds)
    ctx.store
      .findBy(Order, {
        nft: In([...Array.from(nftIds.values())]),
        network: ModelNetwork.POLYGON,
      })
      .then((q) => new Map(q.map((i) => [i.id, i]))),

    // Items (depends on nftItemIds)
    ctx.store
      .find(Item, {
        relations: {
          collection: true,
          metadata: true,
        },
        where: [
          {
            collection: In([...collectionIds]),
            network: ModelNetwork.POLYGON,
          },
          {
            id: In([...itemIdsFlat]),
            network: ModelNetwork.POLYGON,
          },
          {
            id: In([...nftItemIds]),
            network: ModelNetwork.POLYGON,
          },
        ],
      })
      .then((q) => new Map(q.map((i) => [i.id, i]))),
  ]);

  // Accounts query depends on items
  const itemRelatedAccounts = [
    ...Array.from(items.values()).map((item) => item.creator),
    ...Array.from(items.values()).map((item) => item.beneficiary),
  ];

  const accountIdsToLookFor = [...accountIds, ...itemRelatedAccounts].map(
    (id) => `${id}-${ModelNetwork.POLYGON}`
  );

  const accounts = await ctx.store
    .findBy(Account, {
      id: In(accountIdsToLookFor),
      network: ModelNetwork.POLYGON,
    })
    .then((q) => new Map(q.map((i) => [i.id, i])));

  return {
    counts,
    accounts,
    collections,
    orders,
    bids,
    nfts,
    analytics,
    itemDayDatas,
    accountsDayDatas,
    items,
    wearables,
    emotes,
    metadatas,
    rarities,
  };
};
