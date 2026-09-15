import { ChainId, Network } from "@dcl/schemas";
import { getCategory } from "../common/utils/category";
import { EthereumInMemoryState } from "./types";
import { Category } from "../model";
import { getAddresses } from "../common/utils/addresses";
import { Contract as MarketplaceContract } from "../abi/Marketplace";
import { Contract as ERC721BidContract } from "../abi/ERC721Bid";
import { Context } from "./processor";
import { BlockData } from "./processor";
import { startBlockByNetwork } from "./data/contracts/start-blocks";
import { createFeeCache } from "../common/utils/feeCache";
import { Contract as OffChainMarketplaceContract } from "../abi/DecentralandMarketplaceEthereum";

export const getBatchInMemoryState: () => EthereumInMemoryState = () => ({
  transfers: new Map(),
  collectionIds: new Set(),
  mints: new Map(),
  itemIds: new Map(),
  tokenIds: new Map(),
  landTokenIds: new Set(),
  estateTokenIds: new Set(),
  ensTokenIds: new Set(),
  accountIds: new Set(),
  analyticsIds: new Set(),
  transferEvents: new Map(),
  estateEvents: [],
  parcelEvents: [],
  ensEvents: [],
  markteplaceEvents: [],
  bidIds: new Set(),
});

export const addEventToStateIdsBasedOnCategory = (
  nftAddress: string,
  assetId: bigint,
  {
    landTokenIds,
    estateTokenIds,
    ensTokenIds,
    tokenIds,
  }: Pick<
    EthereumInMemoryState,
    "landTokenIds" | "estateTokenIds" | "ensTokenIds" | "tokenIds"
  >
) => {
  const category = getCategory(Network.ETHEREUM, nftAddress);
  if (category === Category.parcel) {
    landTokenIds.add(assetId);
  } else if (category === Category.estate) {
    estateTokenIds.add(assetId);
  } else if (category === Category.ens) {
    ensTokenIds.add(assetId);
  } else {
    tokenIds.set(nftAddress, [...(tokenIds.get(nftAddress) || []), assetId]);
  }
};

export type OffChainMarketplaceContractData = { feeRate: bigint | undefined };

/**
 * Fee rate per emitting marketplace, lowercased. Ethereum's marketplace has no royalties and no
 * collector to record, so a rate is all a sale needs from it. Staging is shared with the Polygon
 * processor — see common/utils/feeCache.
 */
const offChainMarketplaceFeeCache = createFeeCache<OffChainMarketplaceContractData>(
  () => ({ feeRate: undefined }),
  (base, patch) => ({ feeRate: patch.feeRate ?? base.feeRate })
);

export const beginOffChainMarketplaceFeeBatch = (fromBlock: number) =>
  offChainMarketplaceFeeCache.begin(fromBlock);

export const endOffChainMarketplaceFeeBatch = (toBlock: number) =>
  offChainMarketplaceFeeCache.end(toBlock);

/** Empties the committed cache and any open or pending batch. For tests. */
export const resetOffChainMarketplaceContractData = () =>
  offChainMarketplaceFeeCache.reset();

export const setOffChainMarketplaceFeeRate = (
  marketplaceAddress: string,
  value: bigint
) => offChainMarketplaceFeeCache.write(marketplaceAddress, { feeRate: value });

/**
 * The fee rate of an off-chain marketplace, read from chain ONCE per contract and kept current from
 * that contract's own FeeRateUpdated events. Resolved by the emitting address because each deployed
 * version keeps its own.
 *
 * The read targets the block BEFORE the trade's. State at N is post-block, so a rate update later in
 * N would otherwise price a trade earlier in it. Updates earlier in N have already been replayed by
 * the time the trade is handled, so a rate that is still missing is one nothing changed before it.
 *
 * Deliberately not wrapped in try/catch: the value lands in a Sale's money column, so a failed read
 * must fail the batch and be retried rather than record a sale with no fee.
 */
export const getOffChainMarketplaceFeeRate = async (
  ctx: Context,
  block: BlockData,
  marketplaceAddress: string
): Promise<bigint> => {
  const cached = offChainMarketplaceFeeCache.view(marketplaceAddress).feeRate;
  if (cached !== undefined) {
    return cached;
  }
  const contract = new OffChainMarketplaceContract(
    ctx,
    { ...block.header, height: block.header.height - 1 },
    marketplaceAddress
  );
  const feeRate = await contract.feeRate();
  setOffChainMarketplaceFeeRate(marketplaceAddress, feeRate);
  return feeRate;
};

export let marketplaceOwnerCutPerMillion: bigint | null = null;
export let bidOwnerCutPerMillion: bigint | null = null;

export const getMarketplaceOwnerCutPerMillion = () => {
  return marketplaceOwnerCutPerMillion;
};

export const getBidOwnerCutPerMillion = () => {
  return bidOwnerCutPerMillion;
};

export const setMarketplaceOwnerCutPerMillion = (value: bigint) => {
  marketplaceOwnerCutPerMillion = value;
};

export const setBidOwnerCutPerMillion = (value: bigint) => {
  bidOwnerCutPerMillion = value;
};

const getContractOwnerCutPerMillion = async (
  ctx: Context,
  block: BlockData,
  contract: "Marketplace" | "ERC721Bid"
) => {
  const addresses = getAddresses(Network.ETHEREUM);
  const c =
    contract === "ERC721Bid"
      ? new ERC721BidContract(ctx, block.header, addresses.Marketplace)
      : new MarketplaceContract(ctx, block.header, addresses.Marketplace);

  const value = await c.ownerCutPerMillion();
  if (contract === "Marketplace") {
    marketplaceOwnerCutPerMillion = value;
  } else {
    bidOwnerCutPerMillion = value;
  }
};

export const getOwnerCutsValues = async (ctx: Context, block: BlockData) => {
  const chainId = process.env.ETHEREUM_CHAIN_ID || ChainId.ETHEREUM_MAINNET;
  if (marketplaceOwnerCutPerMillion === null) {
    const marketplaceContractCreation =
      startBlockByNetwork[chainId].MarketplaceProxy;
    if (block.header.height >= marketplaceContractCreation) {
      await getContractOwnerCutPerMillion(ctx, block, "Marketplace");
    }
  }
  if (bidOwnerCutPerMillion === null) {
    const bidERC721Creation = startBlockByNetwork[chainId].ERC721Bid;
    if (block.header.height >= bidERC721Creation) {
      await getContractOwnerCutPerMillion(ctx, block, "ERC721Bid");
    }
  }
  return {
    marketplaceOwnerCutPerMillion,
    bidOwnerCutPerMillion,
  };
};
