import { ChainId, Network } from "@dcl/schemas";
import { PolygonInMemoryState } from "./types";
import { Sale } from "../model";
import { getAddresses } from "../common/utils/addresses";
import { Contract as MarketplaceContract } from "./abi/Marketplace";
import { Contract as MarketplaceV2Contract } from "./abi/MarketplaceV2";
import { Contract as OffChainMarketplaceContract } from "./abi/DecentralandMarketplacePolygon";
import { Contract as CollectionStoreContract } from "./abi/CollectionStore";
import { Contract as ERC721BidV2Contract } from "./abi/ERC721BidV2";
import { Block, Context } from "./processor";

const chainId = +(process.env.POLYGON_CHAIN_ID || ChainId.MATIC_MAINNET);

export const getBatchInMemoryState: () => PolygonInMemoryState = () => ({
  curations: new Map(),
  mints: new Map(),
  transfers: new Map(),
  transferGiftCandidates: new Map(),
  sales: new Map<string, Sale>(),
  squidRouterOrders: new Map(),
  // ids
  tokenIds: new Map(),
  accountIds: new Set(),
  collectionIds: new Set(),
  analyticsIds: new Set(),
  itemDayDataIds: new Set(),
  bidIds: new Set(),
  consumedIssueLogs: new Set(),
  itemIds: new Map(),
  // events
  transferEvents: new Map(),
  collectionFactoryEvents: [],
  events: [],
  committeeEvents: [],
  rarityEvents: [],
});

export type StoreContractData = {
  fee: bigint | undefined;
  feeOwner: string | undefined;
};

export type MarketplaceContractData = {
  ownerCutPerMillion: bigint | undefined;
  owner: string | undefined;
};

export type MarketplaceV2ContractData = {
  feesCollectorCutPerMillion: bigint | undefined;
  feesCollector: string | undefined;
  royaltiesCutPerMillion: bigint | undefined;
};

export type BidContractData = {
  ownerCutPerMillion: bigint | undefined;
  owner: string | undefined;
};

export type BidV2ContractData = {
  feesCollectorCutPerMillion: bigint | undefined;
  feesCollector: string | undefined;
  royaltiesCutPerMillion: bigint | undefined;
};

export let marketplaceContractData: MarketplaceContractData = {
  ownerCutPerMillion: undefined,
  owner: undefined,
};

export let marketplaceV2ContractData: MarketplaceV2ContractData = {
  feesCollectorCutPerMillion: undefined,
  feesCollector: undefined,
  royaltiesCutPerMillion: undefined,
};

export let bidV2ContractData: BidV2ContractData = {
  feesCollectorCutPerMillion: undefined,
  feesCollector: undefined,
  royaltiesCutPerMillion: undefined,
};

export let storeContractData: StoreContractData = {
  fee: undefined,
  feeOwner: undefined,
};

export type OffChainMarketplaceContractData = {
  feeCollector: string | undefined;
  feeRate: bigint | undefined;
  royaltiesRate: bigint | undefined;
};

// Keyed by the emitting marketplace, lowercased: every deployed version keeps its own configuration.
// Only batches that complete reach this map; see the staged copy below.
export const offChainMarketplaceContractData = new Map<
  string,
  OffChainMarketplaceContractData
>();

/**
 * Fee writes made while a batch runs. A batch that throws is retried with the same process memory,
 * so writing straight to the committed map would let the retry's early trades read fee values from
 * later in that same batch. Everything a batch learns — replayed updates and cold-cache seeds alike —
 * lands here, and is promoted only once the processor is seen to have moved past the batch: the one
 * signal available inside the handler that the batch's transaction committed.
 */
let stagedOffChainMarketplaceContractData: Map<
  string,
  OffChainMarketplaceContractData
> | null = null;

/**
 * The last ended batch's writes, held until the next batch proves that one committed.
 *
 * `fromBlock` is kept as well as `toBlock` so a re-delivery can be told apart: one that starts at or
 * before the batch did replays every update in it, while one that starts inside it does not.
 */
let pendingOffChainMarketplaceContractData: {
  fromBlock: number;
  toBlock: number;
  writes: Map<string, OffChainMarketplaceContractData>;
} | null = null;

/** The highest block whose writes were promoted. A batch starting at or below it is a rollback. */
let promotedToBlock = -1;

/** Where the open batch started, carried into the pending slot when it ends. */
let openedAtBlock = -1;

const emptyFeeConfig = (): OffChainMarketplaceContractData => ({
  feeCollector: undefined,
  feeRate: undefined,
  royaltiesRate: undefined,
});

const mergeFeeConfig = (
  base: OffChainMarketplaceContractData,
  patch: Partial<OffChainMarketplaceContractData>
): OffChainMarketplaceContractData => ({
  feeCollector: patch.feeCollector ?? base.feeCollector,
  feeRate: patch.feeRate ?? base.feeRate,
  royaltiesRate: patch.royaltiesRate ?? base.royaltiesRate,
});

const promoteFeeWrites = (writes: Map<string, OffChainMarketplaceContractData>) => {
  for (const [key, patch] of writes) {
    offChainMarketplaceContractData.set(
      key,
      mergeFeeConfig(offChainMarketplaceContractData.get(key) ?? emptyFeeConfig(), patch)
    );
  }
};

/**
 * Opens a batch's staging area, deciding the previous batch's fate from where this one starts.
 *
 * The processor only advances past a batch it has committed, so a start after the previous batch's
 * end promotes that batch's writes. A start at or before that end is a re-delivery of it, and its
 * writes are dropped. A start at or before an already promoted block is a rollback into promoted
 * history, so the whole cache is dropped.
 *
 * Dropping is only safe while the re-delivery replays what was dropped. One that starts at or before
 * the batch did covers all of it, so forgetting the writes is enough. One that starts INSIDE it never
 * replays the updates before its own start, and an entry with all three fields set never reads the
 * chain again, so forgetting there would leave a stale value in place for good — those entries are
 * invalidated instead, which costs a read and re-seeds them.
 */
export const beginOffChainMarketplaceFeeBatch = (fromBlock: number) => {
  const pending = pendingOffChainMarketplaceContractData;
  pendingOffChainMarketplaceContractData = null;
  if (fromBlock <= promotedToBlock) {
    offChainMarketplaceContractData.clear();
    promotedToBlock = -1;
  } else if (pending) {
    if (fromBlock > pending.toBlock) {
      promoteFeeWrites(pending.writes);
      promotedToBlock = pending.toBlock;
    } else if (fromBlock > pending.fromBlock) {
      for (const marketplaceAddress of pending.writes.keys()) {
        offChainMarketplaceContractData.delete(marketplaceAddress);
      }
    }
  }
  openedAtBlock = fromBlock;
  stagedOffChainMarketplaceContractData = new Map();
};

/** Ends the batch, holding its writes until the next batch shows the processor moved past `toBlock`. */
export const endOffChainMarketplaceFeeBatch = (toBlock: number) => {
  if (stagedOffChainMarketplaceContractData) {
    pendingOffChainMarketplaceContractData = {
      fromBlock: openedAtBlock,
      toBlock,
      writes: stagedOffChainMarketplaceContractData,
    };
  }
  stagedOffChainMarketplaceContractData = null;
};

/** Empties the committed cache and any open or pending batch. For tests. */
export const resetOffChainMarketplaceContractData = () => {
  offChainMarketplaceContractData.clear();
  stagedOffChainMarketplaceContractData = null;
  pendingOffChainMarketplaceContractData = null;
  promotedToBlock = -1;
  openedAtBlock = -1;
};

/** What the batch currently knows about a marketplace: committed values under its staged writes. */
const viewOffChainMarketplaceContractData = (
  marketplaceAddress: string
): OffChainMarketplaceContractData => {
  const key = marketplaceAddress.toLowerCase();
  return mergeFeeConfig(
    offChainMarketplaceContractData.get(key) ?? emptyFeeConfig(),
    stagedOffChainMarketplaceContractData?.get(key) ?? emptyFeeConfig()
  );
};

const writeOffChainMarketplaceContractData = (
  marketplaceAddress: string,
  patch: Partial<OffChainMarketplaceContractData>
) => {
  const key = marketplaceAddress.toLowerCase();
  // Outside a batch (tests, tooling) writes go straight to the committed cache.
  const target = stagedOffChainMarketplaceContractData ?? offChainMarketplaceContractData;
  target.set(key, mergeFeeConfig(target.get(key) ?? emptyFeeConfig(), patch));
};

/**
 * Fee configuration of an off-chain marketplace, read from the chain ONCE per contract and kept
 * current from that contract's own FeeCollectorUpdated / FeeRateUpdated / RoyaltiesRateUpdated
 * events. Resolved by the emitting address because the versions differ: V3 on Polygon collects into
 * a different Safe than V1/V2, so one shared copy would attribute its fees to the wrong collector.
 *
 * handleTraded used to read all three per Traded event — three sequential eth_calls for values
 * that change roughly never. Against the RPC client's rate limit that was ~0.3s per trade, and
 * because the calls were not attributed to any rpcTime bucket it showed up as unexplained
 * "event loop" time: 548s of a 671s batch on a prod backfill through 2025 blocks.
 *
 * Unlike the other getters here there is no start-block guard, and none is needed: this is only
 * ever called from handleTraded, and a Traded event cannot exist before the contract does.
 *
 * Deliberately NOT wrapped in try/catch, unlike its siblings. These values land in the Sale's
 * money columns (feesCollectorCut, royaltiesCut), so a read failure must fail the batch and be
 * retried — swallowing it would either skip the sale or record it with empty fees.
 */
export const getOffChainMarketplaceContractData = async (
  ctx: Context,
  block: Block,
  marketplaceAddress: string
): Promise<{ feeCollector: string; feeRate: bigint; royaltiesRate: bigint }> => {
  let { feeCollector, feeRate, royaltiesRate } =
    viewOffChainMarketplaceContractData(marketplaceAddress);
  if (
    feeCollector === undefined ||
    feeRate === undefined ||
    royaltiesRate === undefined
  ) {
    console.log(
      `INFO: Fetching marketplace contract data for ${marketplaceAddress} for first time`
    );
    // Read the block BEFORE the trade's. State at N is post-block, so a fee update later in N would
    // leak into a trade earlier in it. Updates earlier in N have already been replayed into the
    // fields that are present, so the missing ones are exactly those nothing changed before this trade.
    const c = new OffChainMarketplaceContract(
      ctx,
      { ...block, height: block.height - 1 },
      marketplaceAddress
    );
    const [chainFeeCollector, chainFeeRate, chainRoyaltiesRate] = await Promise.all([
      c.feeCollector(),
      c.feeRate(),
      c.royaltiesRate(),
    ]);
    feeCollector ??= chainFeeCollector;
    feeRate ??= chainFeeRate;
    royaltiesRate ??= chainRoyaltiesRate;
    writeOffChainMarketplaceContractData(marketplaceAddress, {
      feeCollector,
      feeRate,
      royaltiesRate,
    });
  }
  return { feeCollector, feeRate, royaltiesRate };
};

export const setOffChainMarketplaceFeeCollector = (
  marketplaceAddress: string,
  value: string
) => {
  writeOffChainMarketplaceContractData(marketplaceAddress, { feeCollector: value });
};

export const setOffChainMarketplaceFeeRate = (
  marketplaceAddress: string,
  value: bigint
) => {
  writeOffChainMarketplaceContractData(marketplaceAddress, { feeRate: value });
};

export const setOffChainMarketplaceRoyaltiesRate = (
  marketplaceAddress: string,
  value: bigint
) => {
  writeOffChainMarketplaceContractData(marketplaceAddress, { royaltiesRate: value });
};

// CollectionStore contract creation blocks
const START_BLOCK_COLLECTION_STORE: Record<number, number> = {
  [ChainId.MATIC_AMOY]: 5706656, // Same as MarketplaceV2 for testnet
  [ChainId.MATIC_MAINNET]: 15202567,
};

export const getStoreContractData = async (ctx: Context, block: Block) => {
  const contractStartingBlock = START_BLOCK_COLLECTION_STORE[chainId];
  
  // Only fetch if contract exists at this block height
  if (
    (storeContractData.fee === undefined ||
      storeContractData.feeOwner === undefined) &&
    block.height >= contractStartingBlock
  ) {
    console.log("INFO: Fetching store contract data for first time");
    const addresses = getAddresses(Network.MATIC);
    const storeContract = new CollectionStoreContract(
      ctx,
      block,
      addresses.CollectionStore
    );
    try {
      storeContractData.fee = await storeContract.fee();
      storeContractData.feeOwner = await storeContract.feeOwner();
    } catch (e: any) {
      // The contract may not be readable at this (historical) block on some RPC
      // providers — e.g. fee() returns 0x and decoding throws. Leave the data
      // undefined and retry on a later batch rather than crashing the processor.
      console.log(`WARN: could not fetch store contract data: ${e.message}`);
    }
  }
  return storeContractData;
};

const START_BLOCK_MARKETPLACEV1: Record<number, number> = {
  [ChainId.MATIC_AMOY]: 14517370,
  [ChainId.MATIC_MAINNET]: 15202000,
};

export const getMarketplaceContractData = async (
  ctx: Context,
  block: Block
) => {
  const contractStartingBlock = START_BLOCK_MARKETPLACEV1[chainId];
  
  // Only fetch if contract exists at this block height (and only on mainnet)
  if (
    chainId === ChainId.MATIC_MAINNET && // there's no contract for AMOY
    (marketplaceContractData.ownerCutPerMillion === undefined ||
      marketplaceContractData.owner === undefined) &&
    block.height >= contractStartingBlock
  ) {
    console.log("INFO: Fetching Marketplace v1 contract data for first time");
    const addresses = getAddresses(Network.MATIC);
    const c = new MarketplaceContract(ctx, block, addresses.Marketplace);
    try {
      marketplaceContractData.ownerCutPerMillion = await c.ownerCutPerMillion();
      marketplaceContractData.owner = await c.owner();
    } catch (e: any) {
      console.log(`WARN: could not fetch marketplace contract data: ${e.message}`);
    }
  }
  return marketplaceContractData;
};

const START_BLOCK_MARKETPLACEV2: Record<number, number> = {
  [ChainId.MATIC_AMOY]: 5706656,
  [ChainId.MATIC_MAINNET]: 22514900,
};

export const getMarketplaceV2ContractData = async (
  ctx: Context,
  block: Block
) => {
  const contractStartingBlock = START_BLOCK_MARKETPLACEV2[chainId];
  if (
    (marketplaceV2ContractData.feesCollectorCutPerMillion === undefined ||
      marketplaceV2ContractData.feesCollector === undefined ||
      marketplaceV2ContractData.royaltiesCutPerMillion === undefined) &&
    block.height >= contractStartingBlock
  ) {
    console.log("INFO: Fetching marketplace v2 contract data for first time");
    const addresses = getAddresses(Network.MATIC);
    const c = new MarketplaceV2Contract(ctx, block, addresses.MarketplaceV2);
    try {
      marketplaceV2ContractData.feesCollectorCutPerMillion =
        await c.feesCollectorCutPerMillion();
      marketplaceV2ContractData.feesCollector = await c.feesCollector();
      marketplaceV2ContractData.royaltiesCutPerMillion =
        await c.royaltiesCutPerMillion();
    } catch (e: any) {
      console.log(`WARN: could not fetch marketplace v2 contract data: ${e.message}`);
    }
  }
  return marketplaceV2ContractData;
};

const START_BLOCK_BIDV2: Record<number, number> = {
  [ChainId.MATIC_AMOY]: 5706662,
  [ChainId.MATIC_MAINNET]: 22913743,
};

export const getBidV2ContractData = async (ctx: Context, block: Block) => {
  const contractStartingBlock = START_BLOCK_BIDV2[chainId];
  if (
    (bidV2ContractData.feesCollectorCutPerMillion === undefined ||
      bidV2ContractData.feesCollector === undefined ||
      bidV2ContractData.royaltiesCutPerMillion === undefined) &&
    block.height >= contractStartingBlock
  ) {
    console.log("INFO: Fetching bid v2 contract data for first time");
    const addresses = getAddresses(Network.MATIC);
    const c = new ERC721BidV2Contract(ctx, block, addresses.BidV2);
    try {
      bidV2ContractData.feesCollectorCutPerMillion =
        await c.feesCollectorCutPerMillion();
      bidV2ContractData.feesCollector = await c.feesCollector();
      bidV2ContractData.royaltiesCutPerMillion =
        await c.royaltiesCutPerMillion();
    } catch (e: any) {
      console.log(`WARN: could not fetch bid v2 contract data: ${e.message}`);
    }
  }
  return bidV2ContractData;
};

export const setStoreFee = (fee: bigint) => {
  storeContractData.fee = fee;
};

export const setStoreFeeOwner = (feeOwner: string) => {
  storeContractData.feeOwner = feeOwner;
};

export let marketplaceOwnerCutPerMillion: bigint | null = null;
export let marketplaceV2OwnerCutPerMillion: bigint | null = null;
export let bidOwnerCutPerMillion: bigint | null = null;

export const getMarketplaceOwnerCutPerMillion = () => {
  return marketplaceOwnerCutPerMillion;
};

export const getMarketplaceV2OwnerCutPerMillion = () => {
  return marketplaceV2OwnerCutPerMillion;
};

export const getBidOwnerCutPerMillion = () => {
  return bidOwnerCutPerMillion;
};

export const setMarketplaceOwnerCutPerMillion = (value: bigint) => {
  marketplaceOwnerCutPerMillion = value;
};

export const setMarketplaceV2OwnerCutPerMillion = (value: bigint) => {
  marketplaceV2OwnerCutPerMillion = value;
};

export const setBidOwnerCutPerMillion = (value: bigint) => {
  bidOwnerCutPerMillion = value;
};
