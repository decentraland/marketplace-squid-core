import { In, Not } from "typeorm";
import { TypeormDatabase, Store } from "@subsquid/typeorm-store";
import { Network } from "@dcl/schemas";
import {
  Order,
  Rarity,
  Transfer,
  Network as ModelNetwork,
  Collection,
  Currency,
  ItemsDayData,
  SquidRouterOrder,
  NFT,
  Item,
  Metadata,
  Bid,
  Sale,
  Mint,
  Curation,
} from "../model";

// ⚡ PERFORMANCE FLAG: Toggle between parallel and sequential upserts
// Set to false to test if sequential is faster (avoids DB connection saturation)
const UPSERT_IN_PARALLEL = false;
import * as CollectionFactoryABI from "./abi/CollectionFactory";
import * as CollectionFactoryV3ABI from "./abi/CollectionFactoryV3";
import * as CollectionV2ABI from "./abi/CollectionV2";
import * as MarketplaceABI from "./abi/Marketplace";
import * as MarketplaceV2ABI from "./abi/MarketplaceV2";
import * as CommitteeABI from "./abi/Committee";
import * as RaritiesABI from "./abi/Rarity";
import * as MarketplaceV3ABI from "./abi/DecentralandMarketplacePolygon";
import * as ERC721BidABI from "./abi/ERC721Bid";
import * as CollectionStoreABI from "./abi/CollectionStore";
import * as CollectionManagerABI from "./abi/CollectionManager";
import * as CreditsManagerABI from "./abi/CreditsManager";
import * as SpokeABI from "../abi/Spoke";
import {
  fetchCollectionDataMulticall,
  type CollectionData,
} from "./utils/collectionMulticall";
import {
  dropIndicesForBulkLoad,
  recreateIndices,
  getIndexState,
  checkIfNearHead,
} from "../common/utils/indexManager";
import { getAddresses } from "../common/utils/addresses";
import {
  encodeTokenId,
  handleAddItem,
  handleCollectionCreation,
  handleCompleteCollection,
  handleIssue,
  handleRescueItem,
  handleSetApproved,
  handleSetEditable,
  handleSetGlobalManager,
  handleSetGlobalMinter,
  handleSetItemManager,
  handleSetItemMinter,
  handleTransfer,
  handleTransferCreatorship,
  handleTransferOwnership,
  handleUpdateItemData,
} from "./handlers/collection";
import { processor } from "./processor";
import {
  getBatchInMemoryState,
  getBidV2ContractData,
  getMarketplaceContractData,
  getMarketplaceV2ContractData,
  getStoreContractData,
  setBidOwnerCutPerMillion,
  setMarketplaceOwnerCutPerMillion,
  setStoreFee,
  setStoreFeeOwner,
} from "./state";
import { getStoredData } from "./store";
import { handleMemeberSet } from "./handlers/committee";
import { handleAddRarity, handleUpdatePrice } from "./handlers/rarity";
import { getBidId } from "../common/handlers/bid";
import {
  handleBidAccepted,
  handleBidCancelled,
  handleBidCreated,
} from "./handlers/bid";
import {
  handleOrderCancelled,
  handleOrderCreated,
  handleOrderSuccessful,
  handleTraded,
} from "./handlers/marketplace";
import { getNFTId } from "../common/utils";
import { handleRaritiesSet } from "./handlers/collectionManager";
import { loadCollections } from "./utils/loaders";
import { checkCpuUsageAndThrottle } from "../tools/os";
import {
  getTradeEventData,
  getTradeEventType,
} from "../common/utils/marketplaceV3";
import { getLastNotified } from "../common/utils/events";

const schemaName = process.env.DB_SCHEMA;
const addresses = getAddresses(Network.MATIC);
let bytesRead = 0; // amount of bytes received
const preloadedCollections = loadCollections().addresses;
const preloadedCollectionsHeight = loadCollections().height;
// Cache lastNotified timestamp to avoid querying DB for historical blocks
let cachedLastNotified: bigint | null = null;
let lastNotifiedLoaded = false;

// ⚡ BULK INDEX MODE: Drop indices during initial sync, recreate when caught up
// Enable via env var: BULK_INDEX_MODE=true
const BULK_INDEX_MODE = true;
// const BULK_INDEX_MODE = process.env.BULK_INDEX_MODE === 'true';
let bulkModeInitialized = false;
let indicesRecreated = false;

// 📊 Universal event counter - tracks total events processed across all batches
let totalEventsProcessed = 0;

// ⚡ Extracted upsert function for cleaner code and benchmarking
interface UpsertResult {
  timing: {
    phase1: number;
    metadatas: number;
    items: number;
    nfts1: number;
    orders: number;
    phase4: number;
    total: number;
  };
  nftsWithOrdersCount: number;
}

async function performUpserts(
  store: Store,
  fmt: (ms: number) => string,
  storedData: any,
  rarities: Map<string, Rarity>,
  metadatas: Map<string, Metadata>,
  items: Map<string, Item>,
  nfts: Map<string, NFT>,
  orders: Map<string, Order>,
  bids: Map<string, Bid>,
  sales: Map<string, Sale>,
  mints: Map<string, Mint>,
  transfers: Map<string, Transfer>,
  curations: Map<string, Curation>,
  squidRouterOrders: Map<string, SquidRouterOrder>
): Promise<UpsertResult> {
  const upsertStart = performance.now();
  const timing = {
    phase1: 0,
    metadatas: 0,
    items: 0,
    nfts1: 0,
    orders: 0,
    phase4: 0,
    total: 0,
  };

  if (UPSERT_IN_PARALLEL) {
    // ⚡ PARALLEL MODE: All phase 1 upserts at once
    let t0 = performance.now();
    await Promise.all([
      store.upsert([...rarities.values()]),
      store.upsert([...storedData.counts.values()]),
      store.upsert([...storedData.accounts.values()]),
      store.upsert([...storedData.collections.values()]),
      store.upsert([...storedData.analytics.values()]),
      store.upsert([...storedData.itemDayDatas.values()]),
      store.upsert([...storedData.accountsDayDatas.values()]),
      store.upsert([...storedData.wearables.values()]),
      store.upsert([...storedData.emotes.values()]),
    ]);
    timing.phase1 = performance.now() - t0;
  } else {
    // ⚡ SEQUENTIAL MODE: One at a time to avoid DB saturation
    let t0 = performance.now();
    await store.upsert([...rarities.values()]);
    await store.upsert([...storedData.counts.values()]);
    await store.upsert([...storedData.accounts.values()]);
    await store.upsert([...storedData.collections.values()]);
    await store.upsert([...storedData.analytics.values()]);
    await store.upsert([...storedData.itemDayDatas.values()]);
    await store.upsert([...storedData.accountsDayDatas.values()]);
    await store.upsert([...storedData.wearables.values()]);
    await store.upsert([...storedData.emotes.values()]);
    timing.phase1 = performance.now() - t0;
  }

  // PHASE 2: Metadatas -> Items (items reference metadata)
  let t0 = performance.now();
  await store.upsert([...metadatas.values()]);
  timing.metadatas = performance.now() - t0;

  t0 = performance.now();
  await store.upsert([...items.values()]);
  timing.items = performance.now() - t0;

  // PHASE 3: NFT <-> Order circular dependency workaround
  const orderByNFT: Map<string, Order> = new Map();
  for (const nft of nfts.values()) {
    if (nft.activeOrder) {
      orderByNFT.set(nft.id, nft.activeOrder);
      nft.activeOrder = null;
    }
  }

  t0 = performance.now();
  await store.upsert([...nfts.values()]); // save NFTs with no orders
  timing.nfts1 = performance.now() - t0;

  t0 = performance.now();
  await store.upsert([...orders.values()]); // save orders
  timing.orders = performance.now() - t0;

  // Restore activeOrder and collect NFTs that need update
  const nftsWithOrders: NFT[] = [];
  for (const [nftId, order] of orderByNFT) {
    const nft = nfts.get(nftId);
    if (nft) {
      nft.activeOrder = order;
      nftsWithOrders.push(nft);
    }
  }

  // PHASE 4: NFTs with orders + bids + inserts
  t0 = performance.now();
  if (UPSERT_IN_PARALLEL) {
    await Promise.all([
      nftsWithOrders.length > 0
        ? store.upsert(nftsWithOrders)
        : Promise.resolve(),
      store.upsert([...bids.values()]),
      store.insert([...sales.values()]),
      store.insert([...mints.values()]),
      store.insert([...transfers.values()]),
      store.insert([...curations.values()]),
      store.insert([...squidRouterOrders.values()]),
    ]);
  } else {
    // Sequential
    if (nftsWithOrders.length > 0) await store.upsert(nftsWithOrders);
    await store.upsert([...bids.values()]);
    await store.insert([...sales.values()]);
    await store.insert([...mints.values()]);
    await store.insert([...transfers.values()]);
    await store.insert([...curations.values()]);
    await store.insert([...squidRouterOrders.values()]);
  }
  timing.phase4 = performance.now() - t0;

  timing.total = performance.now() - upsertStart;

  // Log upsert breakdown if slow
  if (timing.total > 2000) {
    const mode = UPSERT_IN_PARALLEL ? "PARALLEL" : "SEQUENTIAL";
    // Calculate per-item speeds
    const nftSpeed =
      nfts.size > 0 ? (timing.nfts1 / nfts.size).toFixed(2) : "0";
    const phase4Speed =
      nftsWithOrders.length > 0
        ? (timing.phase4 / nftsWithOrders.length).toFixed(2)
        : "0";

    console.log(
      `💾 Upsert [${mode}]: phase1=${fmt(timing.phase1)}, metadatas=${fmt(
        timing.metadatas
      )}, items=${fmt(timing.items)}, nfts1=${fmt(timing.nfts1)}(${
        nfts.size
      } @ ${nftSpeed}ms/nft), orders=${fmt(timing.orders)}, phase4=${fmt(
        timing.phase4
      )}(${nftsWithOrders.length} w/orders)`
    );
  }

  return { timing, nftsWithOrdersCount: nftsWithOrders.length };
}

processor.run(
  new TypeormDatabase({
    isolationLevel: "READ COMMITTED",
    supportHotBlocks: true,
    stateSchema: `polygon_processor_${schemaName}`,
  }),
  async (ctx) => {
    const batchStartTime = performance.now();
    const metrics = {
      blockRange: `${ctx.blocks[0].header.height}-${
        ctx.blocks[ctx.blocks.length - 1].header.height
      }`,
      eventsProcessed: 0,
      rpcCalls: { owner: 0, items: 0, contractData: 0, rarity: 0 },
      rpcTime: { owner: 0, items: 0, rarity: 0, total: 0 }, // RPC timing in ms
      dbQueryTime: 0,
      eventLoopTime: 0,
      upsertTime: 0,
      preIndexTime: 0, // Time to pre-index logs
      ownerMulticallTime: 0, // Time for parallel owner() fetching
      // Granular event loop timing
      eventLoopBreakdown: {
        proxyCreated: 0,
        orderEvents: 0,
        bidEvents: 0,
        transferEvents: 0,
        collectionEvents: 0,
        committeeEvents: 0,
        tradedEvents: 0,
        otherEvents: 0,
      },
      skipped: false,
    };

    // update the amount of bytes read
    bytesRead += ctx.blocks.reduce(
      (acc, block) => acc + Buffer.byteLength(JSON.stringify(block), "utf8"),
      0
    );

    // ⚡ BULK INDEX MODE: Drop indices on first batch if enabled
    if (BULK_INDEX_MODE && !bulkModeInitialized) {
      bulkModeInitialized = true;
      const em = (
        ctx.store as unknown as { em: () => import("typeorm").EntityManager }
      ).em();
      console.log(
        "⚡ BULK INDEX MODE enabled - dropping indices for faster indexing..."
      );
      await dropIndicesForBulkLoad(em);
    }

    // ⚡ OPTIMIZATION 1: Parallelize initial DB queries
    const [rarities, collectionIdsNotIncludedInPreloaded] = await Promise.all([
      ctx.store.find(Rarity).then((q) => new Map(q.map((i) => [i.id, i]))),
      ctx.store
        .find(Collection, {
          where: {
            id: Not(In(preloadedCollections)),
            network: ModelNetwork.POLYGON,
          },
        })
        .then((q) => new Set(q.map((c) => c.id))),
    ]);

    const isThereImportantDataInBatch = ctx.blocks.some((block) =>
      block.logs.some(
        (log) =>
          log.address === addresses.CollectionFactory ||
          log.address === addresses.CollectionFactoryV3 ||
          log.address === addresses.BidV2 ||
          log.address === addresses.ERC721Bid ||
          log.address === addresses.Marketplace ||
          log.address === addresses.MarketplaceV2 ||
          log.address === addresses.OldCommittee ||
          log.address === addresses.Committee ||
          log.address === addresses.CollectionStore ||
          log.address === addresses.RaritiesWithOracle ||
          log.address === addresses.Rarity ||
          log.address === addresses.CollectionManager ||
          log.address === addresses.MarketplaceV3 ||
          log.address === addresses.MarketplaceV3_V2 ||
          preloadedCollections.includes(log.address) ||
          collectionIdsNotIncludedInPreloaded.has(log.address)
      )
    );

    if (
      !isThereImportantDataInBatch &&
      ctx.blocks[ctx.blocks.length - 1].header.height >
        preloadedCollectionsHeight
    ) {
      console.log(
        "INFO: Batch contains important data: ",
        isThereImportantDataInBatch
      );
      return;
    }

    const collectionIdsCreatedInBatch = new Set<string>();
    const inMemoryData = getBatchInMemoryState();
    const {
      sales,
      curations,
      mints,
      squidRouterOrders,
      // ids
      itemIds,
      collectionIds,
      accountIds,
      tokenIds,
      transfers,
      bidIds,
      analyticsIds,
      itemDayDataIds,
      // events
      events,
      collectionFactoryEvents,
      committeeEvents,
    } = inMemoryData;

    ctx.log.info(
      `blocks, amount: ${ctx.blocks.length}, from: ${
        ctx.blocks[0].header.height
      } to: ${ctx.blocks[ctx.blocks.length - 1].header.height}`
    );

    // Load lastNotified once at startup to compare with batch timestamps
    // This avoids querying DB for every transfer in historical blocks
    if (!lastNotifiedLoaded) {
      cachedLastNotified = await getLastNotified(ctx.store);
      lastNotifiedLoaded = true;
      console.log("Loaded lastNotified timestamp:", cachedLastNotified);
    }

    // Get the timestamp of the last block in this batch
    const lastBlockTimestamp = BigInt(
      ctx.blocks[ctx.blocks.length - 1].header.timestamp / 1000
    );

    // Determine if we're processing historical blocks or new blocks
    // If lastBlockTimestamp <= cachedLastNotified, we're processing historical blocks
    // and should skip sending transfer events (pass null)
    // If lastBlockTimestamp > cachedLastNotified, we're processing new blocks
    // and need to check lastNotified in each batch (reload it to keep it updated)
    const isProcessingNewBlocks =
      cachedLastNotified === null || lastBlockTimestamp > cachedLastNotified;

    // If processing new blocks, reload lastNotified once per batch to keep it updated
    // If processing historical blocks, pass null to skip sending events
    let batchLastNotified: bigint | null | undefined = null;
    if (isProcessingNewBlocks) {
      // Load lastNotified once per batch and pass it to all transfers in this batch
      // This avoids querying DB for each transfer
      batchLastNotified = await getLastNotified(ctx.store);
      // Update cache for next batch comparison
      cachedLastNotified = batchLastNotified;
    }

    // ⚡ OPTIMIZATION: Pre-fetch contract data ONCE at the beginning of the batch
    // These are cached after first call, so we just ensure they're loaded
    const lastBlockHeader = ctx.blocks[ctx.blocks.length - 1].header;
    const [
      cachedMarketplaceData,
      cachedMarketplaceV2Data,
      cachedBidV2Data,
      cachedStoreData,
    ] = await Promise.all([
      getMarketplaceContractData(ctx, lastBlockHeader),
      getMarketplaceV2ContractData(ctx, lastBlockHeader),
      getBidV2ContractData(ctx, lastBlockHeader),
      getStoreContractData(ctx, lastBlockHeader),
    ]);

    // ⚡ OPTIMIZATION: Pre-index logs by transactionIndex for O(1) lookups (avoid O(n²) loops)
    const preIndexStart = performance.now();

    // Index: blockHeight-txIndex -> CreditUsed events
    const creditEventsByTx = new Map<
      string,
      { creditId: string; value: bigint }[]
    >();
    // Index: blockHeight-txIndex -> OrderCreated orderHash
    const orderHashByTx = new Map<string, string>();

    for (let block of ctx.blocks) {
      for (let log of block.logs) {
        const txKey = `${block.header.height}-${log.transactionIndex}`;

        // Index CreditUsed events
        if (
          log.topics[0] === CreditsManagerABI.events.CreditUsed.topic &&
          addresses.CreditsManager.map((a: string) => a.toLowerCase()).includes(
            log.address.toLowerCase()
          )
        ) {
          const creditEvent = CreditsManagerABI.events.CreditUsed.decode(log);
          if (!creditEventsByTx.has(txKey)) {
            creditEventsByTx.set(txKey, []);
          }
          creditEventsByTx.get(txKey)!.push({
            creditId: creditEvent._creditId,
            value: creditEvent._value,
          });
        }

        // Index OrderCreated events
        if (
          log.topics[0] === SpokeABI.events.OrderCreated.topic &&
          log.address.toLowerCase() === addresses.Spoke?.toLowerCase()
        ) {
          const orderCreatedEvent = SpokeABI.events.OrderCreated.decode(log);
          orderHashByTx.set(txKey, orderCreatedEvent.orderHash);
        }
      }
    }

    // ⚡ OPTIMIZATION: Collect all ProxyCreated events FIRST for parallel owner() fetching
    const proxyCreatedEvents: { address: string; blockHeader: any }[] = [];

    for (let block of ctx.blocks) {
      for (let log of block.logs) {
        const topic = log.topics[0];
        if (
          (topic === CollectionFactoryABI.events.ProxyCreated.topic ||
            topic === CollectionFactoryV3ABI.events.ProxyCreated.topic) &&
          [addresses.CollectionFactory, addresses.CollectionFactoryV3]
            .map((c) => c.toLowerCase())
            .includes(log.address)
        ) {
          const event =
            topic === CollectionFactoryABI.events.ProxyCreated.topic
              ? CollectionFactoryABI.events.ProxyCreated.decode(log)
              : CollectionFactoryV3ABI.events.ProxyCreated.decode(log);

          proxyCreatedEvents.push({
            address: event._address,
            blockHeader: block.header,
          });
        }
      }
    }

    metrics.preIndexTime = performance.now() - preIndexStart;

    // ⚡ OPTIMIZATION: Fetch ALL collection data via MULTICALL (9 calls per collection → 1 batch)
    // This is the biggest optimization: instead of 9 RPC calls per collection,
    // we fetch name, symbol, owner, creator, isCompleted, isApproved, isEditable, baseURI, chainId
    // for ALL collections in a single multicall batch!
    let prefetchedCollectionData = new Map<string, CollectionData>();

    if (proxyCreatedEvents.length > 0) {
      const multicallStart = performance.now();

      // Use the LAST block in the batch for multicall (all collections exist by then)
      const lastBlock = ctx.blocks[ctx.blocks.length - 1].header;
      const collectionAddresses = proxyCreatedEvents.map((e) => e.address);

      prefetchedCollectionData = await fetchCollectionDataMulticall(
        ctx,
        lastBlock,
        collectionAddresses
      );

      const multicallDuration = performance.now() - multicallStart;
      metrics.ownerMulticallTime = multicallDuration;
      metrics.rpcTime.owner = multicallDuration;
      metrics.rpcTime.total += multicallDuration;
      metrics.rpcCalls.owner = proxyCreatedEvents.length; // Track how many we fetched
    }

    // ⚡ TIMING: Track which event types are slow
    const eventTypeCounts: Record<string, number> = {};
    const eventTypeTimes: Record<string, number> = {};
    const accumulationLoopStart = performance.now();

    // ⚡ OPTIMIZATION: Pre-compute topicToName ONCE (not 19000 times)
    const topicToName: Record<string, string> = {
      [CollectionFactoryABI.events.ProxyCreated.topic]: "ProxyCreated",
      [CollectionFactoryV3ABI.events.ProxyCreated.topic]: "ProxyCreatedV3",
      [MarketplaceABI.events.OrderCreated.topic]: "OrderCreated",
      [MarketplaceABI.events.OrderSuccessful.topic]: "OrderSuccessful",
      [MarketplaceABI.events.OrderCancelled.topic]: "OrderCancelled",
      [ERC721BidABI.events.BidCreated.topic]: "BidCreated",
      [ERC721BidABI.events.BidAccepted.topic]: "BidAccepted",
      [ERC721BidABI.events.BidCancelled.topic]: "BidCancelled",
      [CollectionV2ABI.events.Transfer.topic]: "Transfer",
      [CollectionV2ABI.events.Issue.topic]: "Issue",
      [CollectionV2ABI.events.AddItem.topic]: "AddItem",
      [MarketplaceV3ABI.events.Traded.topic]: "Traded",
    };

    // Track time spent BEFORE eventStart (BigInt operations, etc)
    let preEventTime = 0;

    for (let block of ctx.blocks) {
      // ⚡ OPTIMIZATION: Cache block timestamp conversion ONCE per block
      const blockTimestamp = BigInt(block.header.timestamp / 1000);
      const dayId = (blockTimestamp / BigInt(86400)).toString();

      for (let log of block.logs) {
        const preStart = performance.now();
        const topic = log.topics[0];
        const analyticDayDataId = `${dayId}-${ModelNetwork.POLYGON}`;
        metrics.eventsProcessed++;
        preEventTime += performance.now() - preStart;

        const eventStart = performance.now();

        switch (topic) {
          case CollectionFactoryABI.events.ProxyCreated.topic:
          case CollectionFactoryV3ABI.events.ProxyCreated.topic: {
            if (
              ![addresses.CollectionFactory, addresses.CollectionFactoryV3]
                .map((c) => c.toLowerCase())
                .includes(log.address)
            ) {
              ctx.log.warn(
                `CollectionFactory event found not from collection factory contract: ${log.address}`
              );
              break;
            }

            const event =
              topic === CollectionFactoryABI.events.ProxyCreated.topic
                ? CollectionFactoryABI.events.ProxyCreated.decode(log)
                : CollectionFactoryV3ABI.events.ProxyCreated.decode(log);

            collectionIdsCreatedInBatch.add(event._address);

            // ⚡ OPTIMIZATION: Use pre-fetched data from multicall (O(1) lookup)
            const prefetched = prefetchedCollectionData.get(
              event._address.toLowerCase()
            );

            // If we have prefetched data, use the owner from there
            let owner: string;
            if (prefetched) {
              owner = prefetched.owner;
            } else {
              // Fallback to individual RPC call if multicall failed
              const collectionContract = new CollectionV2ABI.Contract(
                ctx,
                block.header,
                event._address
              );
              const rpcStart = performance.now();
              owner = (await collectionContract.owner()).toLowerCase();
              const rpcDuration = performance.now() - rpcStart;
              metrics.rpcCalls.owner++;
              metrics.rpcTime.owner += rpcDuration;
              metrics.rpcTime.total += rpcDuration;
            }

            accountIds.add(owner);
            collectionIds.add(event._address.toLowerCase());

            // ⚡ OPTIMIZATION: Use pre-indexed lookups (O(1) instead of O(n) loop)
            const txKey = `${block.header.height}-${log.transactionIndex}`;
            const creditEvents = creditEventsByTx.get(txKey) || [];
            const orderHash = orderHashByTx.get(txKey);

            const usedCredits = creditEvents.length > 0;
            const creditValue = creditEvents.reduce(
              (sum, c) => sum + c.value,
              BigInt(0)
            );

            // If credits were used and we have an orderHash, create SquidRouterOrder
            if (usedCredits && orderHash && creditEvents.length > 0) {
              const squidRouterOrder = new SquidRouterOrder({
                id: orderHash,
                orderHash,
                creditIds: creditEvents.map((c) => c.creditId),
                totalCreditsUsed: creditValue,
                txHash: log.transactionHash,
                blockNumber: BigInt(block.header.height),
                timestamp: BigInt(block.header.timestamp / 1000),
                network: ModelNetwork.POLYGON,
              });

              squidRouterOrders.set(orderHash, squidRouterOrder);

              ctx.log.info(
                `SquidRouterOrder created for collection ${event._address}: orderHash ${orderHash}, ${creditEvents.length} credits used, total value ${creditValue} wei`
              );
            } else if (usedCredits) {
              ctx.log.info(
                `Credits detected for collection ${event._address}: ${creditValue} wei (no Squid Router order)`
              );
            }

            collectionFactoryEvents.push({
              event:
                topic === CollectionFactoryABI.events.ProxyCreated.topic
                  ? CollectionFactoryABI.events.ProxyCreated.decode(log)
                  : CollectionFactoryV3ABI.events.ProxyCreated.decode(log),
              block,
              usedCredits,
              creditValue: usedCredits ? creditValue : undefined,
              txHash: log.transactionHash,
            });

            break;
          }
          case MarketplaceABI.events.OrderCreated.topic:
          case MarketplaceV2ABI.events.OrderCreated.topic:
            if (
              ![addresses.Marketplace, addresses.MarketplaceV2]
                .map((c) => c.toLowerCase())
                .includes(log.address)
            ) {
              ctx.log.warn(
                "Marketplace event found not from marketplace contract"
              );
              break;
            }

            const event = MarketplaceABI.events.OrderCreated.decode(log);
            tokenIds.set(event.nftAddress, [
              ...(tokenIds.get(event.nftAddress) || []),
              event.assetId,
            ]);

            // ⚡ Use pre-cached contract data instead of awaiting
            events.push({
              topic,
              event,
              block,
              log,
              marketplaceContractData: cachedMarketplaceData,
              marketplaceV2ContractData: cachedMarketplaceV2Data,
              bidV2ContractData: cachedBidV2Data,
            });
            break;

          case MarketplaceABI.events.OrderSuccessful.topic:
          case MarketplaceV2ABI.events.OrderSuccessful.topic: {
            if (
              ![addresses.Marketplace, addresses.MarketplaceV2]
                .map((c) => c.toLowerCase())
                .includes(log.address)
            ) {
              ctx.log.warn(
                `Marketplace event found not from marketplace contract`
              );
              break;
            }
            const event = MarketplaceABI.events.OrderSuccessful.decode(log);
            tokenIds.set(event.nftAddress, [
              ...(tokenIds.get(event.nftAddress) || []),
              event.assetId,
            ]);
            accountIds.add(event.seller); // load sellers acount to update metrics
            accountIds.add(event.buyer); // load buyers acount to update metrics
            analyticsIds.add(analyticDayDataId);
            // Add itemDayData ID placeholder for this NFT sale - will be resolved when we have NFT data
            const dayID = blockTimestamp / BigInt(86400);
            const nftId = `${event.nftAddress}-${event.assetId}`;
            const tempItemDayDataId = `${dayID.toString()}-nft-${nftId}`;
            itemDayDataIds.add(tempItemDayDataId);
            // ⚡ Use pre-cached contract data
            events.push({
              topic,
              event,
              block,
              log,
              marketplaceContractData: cachedMarketplaceData,
              marketplaceV2ContractData: cachedMarketplaceV2Data,
              bidV2ContractData: cachedBidV2Data,
            });
            break;
          }

          case MarketplaceABI.events.OrderCancelled.topic:
          case MarketplaceV2ABI.events.OrderCancelled.topic: {
            if (
              ![addresses.Marketplace, addresses.MarketplaceV2]
                .map((c) => c.toLowerCase())
                .includes(log.address)
            ) {
              break;
            }
            const event = MarketplaceABI.events.OrderCancelled.decode(log);
            tokenIds.set(event.nftAddress, [
              ...(tokenIds.get(event.nftAddress) || []),
              event.assetId,
            ]);
            // ⚡ Use pre-cached contract data
            events.push({
              topic,
              event,
              block,
              log,
              marketplaceContractData: cachedMarketplaceData,
              marketplaceV2ContractData: cachedMarketplaceV2Data,
              bidV2ContractData: cachedBidV2Data,
            });
            break;
          }
          // bid events
          case ERC721BidABI.events.BidCreated.topic: {
            const event = ERC721BidABI.events.BidCreated.decode(log);
            tokenIds.set(event._tokenAddress, [
              ...(tokenIds.get(event._tokenAddress) || []),
              event._tokenId,
            ]);

            // ⚡ Use pre-cached contract data
            events.push({
              topic: ERC721BidABI.events.BidCreated.topic,
              event,
              block,
              log,
              marketplaceContractData: cachedMarketplaceData,
              marketplaceV2ContractData: cachedMarketplaceV2Data,
              bidV2ContractData: cachedBidV2Data,
            });
            break;
          }
          case ERC721BidABI.events.BidAccepted.topic: {
            const event = ERC721BidABI.events.BidAccepted.decode(log);
            const bidId = getBidId(
              event._tokenAddress,
              event._tokenId.toString(),
              event._bidder
            );
            accountIds.add(event._seller); // load sellers acount to update metrics
            accountIds.add(event._bidder); // load buyers acount to update metrics
            bidIds.add(bidId);
            tokenIds.set(event._tokenAddress, [
              ...(tokenIds.get(event._tokenAddress) || []),
              event._tokenId,
            ]);
            analyticsIds.add(analyticDayDataId);
            // Add itemDayData ID placeholder for this NFT bid sale
            const dayIDBid = blockTimestamp / BigInt(86400);
            const nftIdBid = `${event._tokenAddress}-${event._tokenId}`;
            const tempItemDayDataIdBid = `${dayIDBid.toString()}-nft-${nftIdBid}`;
            itemDayDataIds.add(tempItemDayDataIdBid);
            // ⚡ Use pre-cached contract data
            events.push({
              topic: ERC721BidABI.events.BidAccepted.topic,
              event,
              block,
              log,
              marketplaceContractData: cachedMarketplaceData,
              marketplaceV2ContractData: cachedMarketplaceV2Data,
              bidV2ContractData: cachedBidV2Data,
            });
            break;
          }
          case ERC721BidABI.events.BidCancelled.topic: {
            const event = ERC721BidABI.events.BidCancelled.decode(log);
            const bidId = getBidId(
              event._tokenAddress,
              event._tokenId.toString(),
              event._bidder
            );
            bidIds.add(bidId);
            tokenIds.set(event._tokenAddress, [
              ...(tokenIds.get(event._tokenAddress) || []),
              event._tokenId,
            ]);
            // ⚡ Use pre-cached contract data
            events.push({
              topic: ERC721BidABI.events.BidCancelled.topic,
              event,
              block,
              log,
              marketplaceContractData: cachedMarketplaceData,
              marketplaceV2ContractData: cachedMarketplaceV2Data,
              bidV2ContractData: cachedBidV2Data,
            });
            break;
          }
          case MarketplaceV2ABI.events.ChangedFeesCollectorCutPerMillion.topic:
          case ERC721BidABI.events.ChangedOwnerCutPerMillion.topic: {
            if (log.address === addresses.Marketplace) {
              const event =
                MarketplaceV2ABI.events.ChangedFeesCollectorCutPerMillion.decode(
                  log
                );
              setMarketplaceOwnerCutPerMillion(
                event.feesCollectorCutPerMillion
              );
            } else {
              const event =
                ERC721BidABI.events.ChangedOwnerCutPerMillion.decode(log);
              setBidOwnerCutPerMillion(event._ownerCutPerMillion);
            }
            break;
          }
          case CommitteeABI.events.MemberSet.topic: {
            if (
              ![addresses.Committee, addresses.OldCommittee]
                .map((c) => c.toLowerCase())
                .includes(log.address)
            ) {
              console.log(
                "ERROR: Committee event found not from committee contract"
              );
              break;
            }
            const event = CommitteeABI.events.MemberSet.decode(log);
            committeeEvents.push(event);
            accountIds.add(event._member.toLowerCase());
            break;
          }
          case CollectionV2ABI.events.SetGlobalMinter.topic:
          case CollectionV2ABI.events.SetGlobalManager.topic:
          case CollectionV2ABI.events.SetItemMinter.topic:
          case CollectionV2ABI.events.SetItemManager.topic:
          case CollectionV2ABI.events.AddItem.topic:
          case CollectionV2ABI.events.RescueItem.topic:
          case CollectionV2ABI.events.UpdateItemData.topic:
          case CollectionV2ABI.events.Issue.topic:
          case CollectionV2ABI.events.SetApproved.topic:
          case CollectionV2ABI.events.SetEditable.topic:
          case CollectionV2ABI.events.Complete.topic:
          case CollectionV2ABI.events.CreatorshipTransferred.topic:
          case CollectionV2ABI.events.OwnershipTransferred.topic:
          case CollectionV2ABI.events.Transfer.topic: {
            // @TODO check addresses
            if (
              ![
                ...preloadedCollections, // collections already pre-calculated
                ...collectionIdsNotIncludedInPreloaded, // collections not included in the preloaded list but yes in the db (newest ones)
                ...collectionIdsCreatedInBatch, // collections created in the current batch, will later by saved in the db
              ].includes(log.address)
            ) {
              break;
            }
            let event;

            switch (topic) {
              case CollectionV2ABI.events.SetGlobalMinter.topic:
                event = CollectionV2ABI.events.SetGlobalMinter.decode(log);
                break;
              case CollectionV2ABI.events.SetGlobalManager.topic:
                event = CollectionV2ABI.events.SetGlobalManager.decode(log);
                break;
              case CollectionV2ABI.events.SetItemMinter.topic:
                event = CollectionV2ABI.events.SetItemMinter.decode(log);
                break;
              case CollectionV2ABI.events.SetItemManager.topic:
                event = CollectionV2ABI.events.SetItemManager.decode(log);
                break;
              case CollectionV2ABI.events.AddItem.topic:
                event = CollectionV2ABI.events.AddItem.decode(log);
                analyticsIds.add(analyticDayDataId);
                break;
              case CollectionV2ABI.events.RescueItem.topic:
                event = CollectionV2ABI.events.RescueItem.decode(log);
                break;
              case CollectionV2ABI.events.UpdateItemData.topic:
                event = CollectionV2ABI.events.UpdateItemData.decode(log);
                itemIds.set(log.address, [
                  ...(itemIds.get(log.address) || []),
                  event._itemId,
                ]);
                break;
              case CollectionV2ABI.events.Issue.topic: {
                event = CollectionV2ABI.events.Issue.decode(log);
                accountIds.add(event._beneficiary.toLowerCase());
                analyticsIds.add(analyticDayDataId);
                // Add itemDayData ID for this item sale
                const dayID = blockTimestamp / BigInt(86400);
                const itemId = `${log.address}-${event._itemId}`;
                const itemDayDataId = `${dayID.toString()}-${itemId}`;
                itemDayDataIds.add(itemDayDataId);
                itemIds.set(log.address, [
                  ...(itemIds.get(log.address) || []),
                  event._itemId,
                ]);
                // account for creator
                // we need to load item creators, seller and royalties accounts
                // we also need the feeCollector account
                break;
              }
              case CollectionV2ABI.events.SetApproved.topic:
                event = CollectionV2ABI.events.SetApproved.decode(log);
                break;
              case CollectionV2ABI.events.SetEditable.topic:
                event = CollectionV2ABI.events.SetEditable.decode(log);
                break;
              case CollectionV2ABI.events.Complete.topic:
                event = CollectionV2ABI.events.Complete.decode(log);
                break;
              case CollectionV2ABI.events.CreatorshipTransferred.topic:
                event =
                  CollectionV2ABI.events.CreatorshipTransferred.decode(log);
                break;
              case CollectionV2ABI.events.OwnershipTransferred.topic:
                event = CollectionV2ABI.events.OwnershipTransferred.decode(log);
                break;
              case CollectionV2ABI.events.Transfer.topic: {
                event = CollectionV2ABI.events.Transfer.decode(log);
                accountIds.add(event.to.toLowerCase());
                const timestamp = block.header.timestamp / 1000;
                const nftId = getNFTId(log.address, event.tokenId.toString());
                tokenIds.set(log.address, [
                  ...(tokenIds.get(log.address) || []),
                  event.tokenId,
                ]);
                transfers.set(
                  `${nftId}-${timestamp}`,
                  new Transfer({
                    id: `${nftId}-${timestamp}`,
                    nftId,
                    block: block.header.height,
                    from: event.from,
                    to: event.to,
                    network: ModelNetwork.POLYGON,
                    timestamp: BigInt(timestamp),
                    txHash: log.transactionHash,
                  })
                );
                break;
              }
            }
            if (event) {
              const raritiesCopy = new Map(
                Array.from(rarities).map(([k, v]) => [k, { ...v }])
              );
              collectionIds.add(log.address.toLowerCase()); // @TODO check lowercase if needed
              // ⚡ Use pre-cached store contract data
              events.push({
                topic,
                event,
                block,
                log,
                transaction: log.transaction,
                // make a copy of rarities so it has an snapshot at this block
                rarities: raritiesCopy,
                storeContractData: cachedStoreData,
              });
            } else {
              console.log("ERROR: Event not decoded correctly");
            }
            break;
          }
          case RaritiesABI.events.AddRarity.topic: {
            const event = RaritiesABI.events.AddRarity.decode(log);
            handleAddRarity(
              rarities,
              event,
              log.address === addresses.Rarity ? Currency.MANA : Currency.USD
            );
            break;
          }
          case RaritiesABI.events.UpdatePrice.topic: {
            const event = RaritiesABI.events.UpdatePrice.decode(log);
            handleUpdatePrice(
              rarities,
              event,
              log.address === addresses.Rarity ? Currency.MANA : Currency.USD
            );
            break;
          }
          case CollectionStoreABI.events.SetFee.topic: {
            const event = CollectionStoreABI.events.SetFee.decode(log);
            setStoreFee(event._newFee);
            break;
          }
          case CollectionStoreABI.events.SetFeeOwner.topic: {
            const event = CollectionStoreABI.events.SetFeeOwner.decode(log);
            setStoreFeeOwner(event._newFeeOwner);
            break;
          }
          case CollectionManagerABI.events.RaritiesSet.topic: {
            const event = CollectionManagerABI.events.RaritiesSet.decode(log);
            // ⚠️ RPC CALLS: handleRaritiesSet makes multiple RPC calls (raritiesCount + rarities[i])
            const rpcRarityStart = performance.now();
            await handleRaritiesSet(ctx, block.header, event, rarities);
            const rpcRarityDuration = performance.now() - rpcRarityStart;
            metrics.rpcCalls.rarity++;
            metrics.rpcTime.rarity += rpcRarityDuration;
            metrics.rpcTime.total += rpcRarityDuration;
            break;
          }
          case MarketplaceV3ABI.events.Traded.topic: {
            const event = MarketplaceV3ABI.events.Traded.decode(log);
            const tradeData = getTradeEventData(event, Network.MATIC);
            const { collectionAddress, buyer, seller, assetType, itemId } =
              tradeData;
            let tokenId = tradeData.tokenId;
            // secondary sale
            if (Number(assetType) === 4 && itemId !== undefined) {
              const collectionContract = new CollectionV2ABI.Contract(
                ctx,
                block.header,
                collectionAddress
              );
              // ⚠️ RPC CALL: collectionContract.items() - one per Traded secondary sale
              const rpcItemsStart = performance.now();
              const item = await collectionContract.items(itemId);
              const rpcItemsDuration = performance.now() - rpcItemsStart;
              metrics.rpcCalls.items++;
              metrics.rpcTime.items += rpcItemsDuration;
              metrics.rpcTime.total += rpcItemsDuration;

              tokenId = encodeTokenId(Number(itemId), Number(item.totalSupply));
            }
            collectionIds.add(collectionAddress);

            if (tokenId) {
              tokenIds.set(collectionAddress, [
                ...(tokenIds.get(collectionAddress) || []),
                tokenId,
              ]);
            } else {
              console.log("ERROR: tokenId not found in trade event data");
              break;
            }
            accountIds.add(seller); // load sellers acount to update metrics
            accountIds.add(buyer); // load buyers acount to update metrics
            analyticsIds.add(analyticDayDataId);
            // Add itemDayData ID for this trade
            const dayIDTrade = blockTimestamp / BigInt(86400);
            if (itemId !== undefined) {
              // Primary sale - we have the itemId directly
              const itemIdStr = `${collectionAddress}-${itemId}`;
              const itemDayDataIdTrade = `${dayIDTrade.toString()}-${itemIdStr}`;
              itemDayDataIds.add(itemDayDataIdTrade);
            } else if (tokenId) {
              // Secondary sale - add placeholder to be resolved later
              const nftIdTrade = `${collectionAddress}-${tokenId}`;
              const tempItemDayDataIdTrade = `${dayIDTrade.toString()}-nft-${nftIdTrade}`;
              itemDayDataIds.add(tempItemDayDataIdTrade);
            }

            // ⚡ Use pre-cached store contract data
            events.push({
              topic,
              event,
              block,
              log,
              transaction: log.transaction,
              // make a copy of rarities so it has an snapshot at this block
              rarities: new Map(
                Array.from(rarities).map(([k, v]) => [k, { ...v }])
              ),
              storeContractData: cachedStoreData,
            });

            break;
          }
        }

        // Track event timing - use pre-computed topicToName
        const eventDuration = performance.now() - eventStart;
        const eventType = topicToName[topic] || "other";
        eventTypeCounts[eventType] = (eventTypeCounts[eventType] || 0) + 1;
        eventTypeTimes[eventType] =
          (eventTypeTimes[eventType] || 0) + eventDuration;
      }
    }

    // Track accumulation loop time (used in Event Loop Breakdown below)
    const accumulationLoopTime = performance.now() - accumulationLoopStart;

    // Calculate total event processing time
    const totalEventTime = Object.values(eventTypeTimes).reduce(
      (a, b) => a + b,
      0
    );
    const unexplainedTime =
      accumulationLoopTime - totalEventTime - preEventTime;

    // get stored data
    const dbQueryStart = performance.now();
    const storedData = await getStoredData(ctx, {
      accountIds,
      collectionIds,
      tokenIds,
      analyticsIds,
      bidIds,
      itemIds,
      itemDayDataIds,
    });
    metrics.dbQueryTime = performance.now() - dbQueryStart;

    const { counts, accounts, orders, bids, nfts, items, metadatas } =
      storedData;

    // Resolve placeholder itemDayDataIds for secondary sales
    const placeholderIds = [...itemDayDataIds].filter((id) =>
      id.includes("-nft-")
    );
    for (const placeholderId of placeholderIds) {
      // Extract dayID and nftId from placeholder: "dayID-nft-contractAddress-tokenId"
      const [dayID, , ...nftIdParts] = placeholderId.split("-");
      const nftId = nftIdParts.join("-");

      const nft = nfts.get(nftId);
      if (nft?.item) {
        // Remove placeholder and add correct ID
        itemDayDataIds.delete(placeholderId);
        const correctItemDayDataId = `${dayID}-${nft.item.id}`;
        itemDayDataIds.add(correctItemDayDataId);
      }
    }

    // Reload itemDayDatas with the corrected IDs
    const additionalItemDayDatas = await ctx.store
      .findBy(ItemsDayData, {
        id: In([...Array.from(itemDayDataIds.values())]),
      })
      .then((q) => new Map(q.map((i) => [i.id, i])));

    // Merge with existing itemDayDatas
    for (const [key, value] of additionalItemDayDatas.entries()) {
      storedData.itemDayDatas.set(key, value);
    }

    // Collection Factory Events
    // ⚡ OPTIMIZATION: Process all collection creations in PARALLEL with MULTICALL data
    const handleCollectionStart = performance.now();
    await Promise.all(
      collectionFactoryEvents.map(
        ({ block, event, usedCredits, creditValue, txHash }) => {
          // Use full prefetched data from multicall
          const prefetched = prefetchedCollectionData.get(
            event._address.toLowerCase()
          );
          return handleCollectionCreation(
            ctx,
            block.header,
            event._address,
            storedData,
            usedCredits,
            creditValue,
            txHash,
            prefetched // Pass ALL prefetched data (name, symbol, owner, etc.)
          );
        }
      )
    );
    metrics.eventLoopBreakdown.proxyCreated =
      performance.now() - handleCollectionStart;

    // Collection Events - process accumulated events
    const collectionEventsStart = performance.now();
    for (const {
      block,
      event,
      topic,
      log,
      transaction,
      rarities,
      storeContractData,
      bidV2ContractData,
      marketplaceContractData,
      marketplaceV2ContractData,
    } of events) {
      switch (topic) {
        case CollectionV2ABI.events.SetGlobalMinter.topic:
          handleSetGlobalMinter(
            log.address,
            event as CollectionV2ABI.SetGlobalMinterEventArgs,
            block.header,
            storedData
          );
          break;
        case CollectionV2ABI.events.SetGlobalManager.topic:
          handleSetGlobalManager(
            log.address,
            event as CollectionV2ABI.SetGlobalManagerEventArgs,
            storedData
          );
          break;
        case CollectionV2ABI.events.SetItemMinter.topic:
          handleSetItemMinter(
            log.address,
            event as CollectionV2ABI.SetItemMinterEventArgs,
            block.header,
            storedData
          );
          break;
        case CollectionV2ABI.events.SetItemManager.topic:
          handleSetItemManager(
            log.address,
            event as CollectionV2ABI.SetItemManagerEventArgs,
            storedData
          );
          break;
        case CollectionV2ABI.events.AddItem.topic:
          rarities &&
            (await handleAddItem(
              ctx,
              block.header,
              log.address,
              event as CollectionV2ABI.AddItemEventArgs,
              storedData,
              rarities
            ));
          break;
        case CollectionV2ABI.events.RescueItem.topic:
          transaction &&
            handleRescueItem(
              event as CollectionV2ABI.RescueItemEventArgs,
              block.header,
              log,
              transaction,
              storedData,
              inMemoryData
            );
          break;
        case CollectionV2ABI.events.UpdateItemData.topic:
          handleUpdateItemData(
            log.address,
            event as CollectionV2ABI.UpdateItemDataEventArgs,
            block.header,
            storedData
          );
          break;
        case MarketplaceV3ABI.events.Traded.topic: {
          if (!storeContractData || !transaction) {
            console.log("ERROR: storeContractData not found");
            break;
          }
          await handleTraded(
            ctx,
            event as MarketplaceV3ABI.TradedEventArgs,
            block,
            transaction,
            storedData,
            inMemoryData
          );
          break;
        }
        case CollectionV2ABI.events.Issue.topic:
          if (!storeContractData) {
            console.log("ERROR: storeContractData not found");
            break;
          }
          if (
            (event as CollectionV2ABI.IssueEventArgs)._caller ===
              addresses.MarketplaceV3 ||
            (event as CollectionV2ABI.IssueEventArgs)._caller ===
              addresses.MarketplaceV3_V2
          ) {
            break;
          }
          await handleIssue(
            ctx,
            log.address,
            event as CollectionV2ABI.IssueEventArgs,
            block.header,
            transaction!,
            storedData,
            inMemoryData,
            storeContractData
          );
          break;
        case CollectionV2ABI.events.SetApproved.topic:
          !!transaction &&
            handleSetApproved(
              log.address,
              event as CollectionV2ABI.SetApprovedEventArgs,
              block.header,
              log,
              transaction,
              storedData
            );
          break;
        case CollectionV2ABI.events.SetEditable.topic:
          handleSetEditable(
            log.address,
            event as CollectionV2ABI.SetEditableEventArgs,
            storedData
          );
          break;
        case CollectionV2ABI.events.Complete.topic:
          handleCompleteCollection(log.address, storedData);
          break;
        case CollectionV2ABI.events.CreatorshipTransferred.topic:
          handleTransferCreatorship(
            log.address,
            event as CollectionV2ABI.CreatorshipTransferredEventArgs,
            block.header,
            storedData
          );
          break;
        case CollectionV2ABI.events.OwnershipTransferred.topic:
          handleTransferOwnership(
            log.address,
            event as CollectionV2ABI.OwnershipTransferredEventArgs,
            block.header,
            storedData
          );
          break;
        case CollectionV2ABI.events.Transfer.topic:
          try {
            await handleTransfer(
              ctx,
              log.address,
              event as CollectionV2ABI.TransferEventArgs,
              block.header,
              storedData,
              batchLastNotified
            );
          } catch (e) {
            console.log("Error in handleTransfer:", e);
            console.log("Transfer event failed for NFT:", log.address, event);
            // Continue processing other events even if this one fails
          }
          break;

        case MarketplaceABI.events.OrderCreated.topic: {
          handleOrderCreated(
            event as MarketplaceABI.OrderCreatedEventArgs,
            block,
            log.address,
            log.transactionHash,
            orders,
            nfts,
            counts
          );
          break;
        }
        case MarketplaceABI.events.OrderSuccessful.topic: {
          if (!marketplaceContractData || !marketplaceV2ContractData) {
            console.log(
              "ERROR: marketplaceContractData or marketplaceV2ContractData not found"
            );
            break;
          }
          await handleOrderSuccessful(
            ctx,
            event as MarketplaceABI.OrderSuccessfulEventArgs,
            block,
            log.transactionHash,
            marketplaceContractData,
            marketplaceV2ContractData,
            storedData,
            inMemoryData
          );
          break;
        }
        case MarketplaceABI.events.OrderCancelled.topic: {
          handleOrderCancelled(
            event as MarketplaceABI.OrderCancelledEventArgs,
            block,
            nfts,
            orders
          );
          break;
        }
        case ERC721BidABI.events.BidCreated.topic: {
          handleBidCreated(
            event as ERC721BidABI.BidCreatedEventArgs,
            block,
            log.address,
            nfts,
            bids,
            counts
          );
          break;
        }
        case ERC721BidABI.events.BidAccepted.topic: {
          if (!bidV2ContractData) {
            console.log("ERROR: bidV2ContractData not found");
            break;
          }
          await handleBidAccepted(
            ctx,
            event as ERC721BidABI.BidAcceptedEventArgs,
            block,
            log.transactionHash,
            bidV2ContractData,
            storedData,
            inMemoryData
          );
          break;
        }
        case ERC721BidABI.events.BidCancelled.topic: {
          handleBidCancelled(
            event as ERC721BidABI.BidCancelledEventArgs,
            block,
            bids,
            nfts
          );
          break;
        }
      }
    }
    metrics.eventLoopBreakdown.collectionEvents =
      performance.now() - collectionEventsStart;

    // Committee Events
    for (const event of committeeEvents) {
      handleMemeberSet(accounts, event);
    }

    // ⚡ FIX: Calculate eventLoopTime as ONLY event processing (not DB queries)
    // Event Loop = accumulation + RPC + handleCollectionCreation + processEvents
    // DB Queries are SEPARATE and should not be included
    metrics.eventLoopTime =
      accumulationLoopTime +
      metrics.rpcTime.total +
      metrics.eventLoopBreakdown.proxyCreated +
      metrics.eventLoopBreakdown.collectionEvents;

    // Helper to format time (show seconds if > 1000ms)
    const fmt = (ms: number) =>
      ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;

    // Log event loop breakdown if slow
    if (metrics.eventLoopTime > 1000 || metrics.dbQueryTime > 1000) {
      // Get top event types by time
      const topEvents = Object.entries(eventTypeTimes)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([type, time]) => `${type}=${fmt(time)}(${eventTypeCounts[type]})`)
        .join(", ");

      console.log(
        `📍 Breakdown: accumulation=${fmt(accumulationLoopTime)}, RPC=${fmt(
          metrics.rpcTime.total
        )}, handleCollection=${fmt(
          metrics.eventLoopBreakdown.proxyCreated
        )}, processEvents=${fmt(metrics.eventLoopBreakdown.collectionEvents)}`
      );
      console.log(`   └─ Events: ${topEvents}`);
    }

    // ⚡ DB UPSERTS - use extracted function
    const upsertResult = await performUpserts(
      ctx.store,
      fmt,
      storedData,
      rarities,
      metadatas,
      items,
      nfts,
      orders,
      bids,
      sales,
      mints,
      transfers,
      curations,
      squidRouterOrders
    );

    metrics.upsertTime = upsertResult.timing.total;
    const totalBatchTime = performance.now() - batchStartTime;

    // Calculate percentages
    const pctDb =
      totalBatchTime > 0
        ? ((metrics.dbQueryTime / totalBatchTime) * 100).toFixed(1)
        : "0";
    const pctEvent =
      totalBatchTime > 0
        ? ((metrics.eventLoopTime / totalBatchTime) * 100).toFixed(1)
        : "0";
    const pctUpsert =
      totalBatchTime > 0
        ? ((metrics.upsertTime / totalBatchTime) * 100).toFixed(1)
        : "0";

    // Check for slow operations (> 1s)
    const warnings: string[] = [];
    if (metrics.dbQueryTime > 1000)
      warnings.push(`DB Queries: ${fmt(metrics.dbQueryTime)}`);
    if (metrics.eventLoopTime > 1000)
      warnings.push(`Event Loop: ${fmt(metrics.eventLoopTime)}`);
    if (metrics.rpcTime.total > 1000)
      warnings.push(`RPC: ${fmt(metrics.rpcTime.total)}`);
    if (metrics.upsertTime > 1000)
      warnings.push(`DB Upserts: ${fmt(metrics.upsertTime)}`);
    if (totalBatchTime > 3000) warnings.push(`Total: ${fmt(totalBatchTime)}`);

    const warningLine =
      warnings.length > 0 ? `\n⚠️  WARNING SLOW: ${warnings.join(" | ")}` : "";

    // RPC timing breakdown (only show if there were RPC calls)
    const rpcBreakdown =
      metrics.rpcTime.total > 0
        ? `\n🌐 RPC: ${fmt(metrics.rpcTime.total)} (owner: ${fmt(
            metrics.ownerMulticallTime
          )}, items: ${fmt(metrics.rpcTime.items)}, rarity: ${fmt(
            metrics.rpcTime.rarity
          )})`
        : "";

    // Update global event counter
    totalEventsProcessed += metrics.eventsProcessed;

    // Log detailed metrics in readable format
    console.log(`
📊 ============ POLYGON BATCH METRICS ============
📦 Blocks: ${metrics.blockRange}
⏱️  Total: ${fmt(totalBatchTime)}
   ├─ DB Queries: ${fmt(metrics.dbQueryTime)} (${pctDb}%)
   ├─ Event Loop: ${fmt(metrics.eventLoopTime)} (${pctEvent}%)
   └─ DB Upserts: ${fmt(metrics.upsertTime)} (${pctUpsert}%)
📈 Events: ${
      metrics.eventsProcessed
    } (total: ${totalEventsProcessed.toLocaleString()})
🔗 RPC: owner=${metrics.rpcCalls.owner}, items=${
      metrics.rpcCalls.items
    }, rarity=${metrics.rpcCalls.rarity}${rpcBreakdown}
💾 Entities: NFTs=${nfts.size}, Items=${items.size}, Collections=${
      storedData.collections.size
    }, Orders=${orders.size}, Sales=${sales.size}, Bids=${bids.size}, Mints=${
      mints.size
    }, Transfers=${transfers.size}, Curations=${curations.size}${warningLine}
=================================================
`);

    ctx.log.info(
      `Batch ${metrics.blockRange} saved: nfts=${nfts.size}, items=${items.size}, sales=${sales.size}, mints=${mints.size}, transfers=${transfers.size}`
    );

    // ⚡ BULK INDEX MODE: Recreate indices when we're caught up with chain head
    // Check if we're within 100 blocks of the chain head (ctx.isHead is true when at tip)
    if (BULK_INDEX_MODE && !indicesRecreated && ctx.isHead) {
      indicesRecreated = true;
      const em = (
        ctx.store as unknown as { em: () => import("typeorm").EntityManager }
      ).em();
      console.log("⚡ Caught up with chain head! Recreating indices...");
      await recreateIndices(em);
    }
  }
);
