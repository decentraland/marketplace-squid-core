import { Multicall, AggregateTuple } from "../../abi/multicall";
import {
  Contract as CollectionV2Contract,
  functions as CollectionV2Functions,
} from "../abi/CollectionV2";
import { POLYGON_CHAIN_ID } from "../../config";
import type { Context, Block } from "../processor";

// Number of contract calls issued per collection. Keep in sync with the calls pushed below,
// the per-collection result slice, and readCollection.
//
// getChainId() is deliberately NOT one of them. It returns `block.chainid`, which for this
// processor is always POLYGON_CHAIN_ID, so calling it spends one RPC per collection to learn a
// constant we already have.
const CALLS_PER_COLLECTION = 8;

const MULTICALL_CONTRACT = "0xcA11bde05977b3631167028862bE2a173976CA11";
// Multicall3 was deployed on Polygon at block 25770160. Everything BELOW it — the first ~28% of
// the chain, and most of the collections ever created — has no multicall and must be read with
// individual eth_calls, which is what fetchCollectionDataDirect is for.
export const POLYGON_MULTICALL_CREATION_BLOCK = 25770160;

// How many collections the direct path reads concurrently. Each issues CALLS_PER_COLLECTION
// eth_calls, so this bounds the promise fan-out; the RPC client's own capacity/rateLimit is
// what actually paces the requests.
const DIRECT_FETCH_CONCURRENCY = 25;

const fmt = (ms: number) =>
  ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;

export interface CollectionData {
  address: string;
  name: string;
  symbol: string;
  owner: string;
  creator: string;
  isCompleted: boolean;
  isApproved: boolean;
  isEditable: boolean;
  baseURI: string;
  chainId: bigint;
}

/**
 * Fetch all collection data for multiple collections in a single multicall batch
 * This reduces CALLS_PER_COLLECTION RPC calls per collection to 1 batch call for ALL collections
 */
export async function fetchCollectionDataMulticall(
  ctx: Context,
  blockHeader: Block,
  collectionAddresses: string[]
): Promise<Map<string, CollectionData>> {
  if (collectionAddresses.length === 0) {
    return new Map();
  }

  // Check if we're past the multicall creation block
  if (blockHeader.height < POLYGON_MULTICALL_CREATION_BLOCK) {
    return new Map(); // Caller will use fetchCollectionDataDirect
  }

  const multicall = new Multicall(ctx, blockHeader, MULTICALL_CONTRACT);
  const results = new Map<string, CollectionData>();

  // Build all calls: CALLS_PER_COLLECTION functions x N collections
  const calls: AggregateTuple[] = [];

  for (const address of collectionAddresses) {
    calls.push([CollectionV2Functions.name, address, {}]);
    calls.push([CollectionV2Functions.symbol, address, {}]);
    calls.push([CollectionV2Functions.owner, address, {}]);
    calls.push([CollectionV2Functions.creator, address, {}]);
    calls.push([CollectionV2Functions.isCompleted, address, {}]);
    calls.push([CollectionV2Functions.isApproved, address, {}]);
    calls.push([CollectionV2Functions.isEditable, address, {}]);
    calls.push([CollectionV2Functions.baseURI, address, {}]);
  }

  const multicallStart = performance.now();

  try {
    // Use tryAggregate to handle individual failures gracefully
    const rawResults = await multicall.tryAggregate(calls, 100); // Page size of 100

    const multicallDuration = performance.now() - multicallStart;
    console.log(
      `✅ Multicall for ${collectionAddresses.length} collections (${
        calls.length
      } calls): ${fmt(multicallDuration)}`
    );

    // Parse results: CALLS_PER_COLLECTION results per collection
    for (let i = 0; i < collectionAddresses.length; i++) {
      const address = collectionAddresses[i].toLowerCase();
      const baseIndex = i * CALLS_PER_COLLECTION;

      // Check if all calls succeeded
      const allSuccess = rawResults
        .slice(baseIndex, baseIndex + CALLS_PER_COLLECTION)
        .every((r) => r.success);

      if (!allSuccess) {
        console.log(
          `⚠️ Multicall failed for collection ${address.slice(
            0,
            10
          )}, will use fallback`
        );
        continue;
      }

      results.set(address, {
        address,
        name: rawResults[baseIndex + 0].value as string,
        symbol: rawResults[baseIndex + 1].value as string,
        owner: (rawResults[baseIndex + 2].value as string).toLowerCase(),
        creator: (rawResults[baseIndex + 3].value as string).toLowerCase(),
        isCompleted: rawResults[baseIndex + 4].value as boolean,
        isApproved: rawResults[baseIndex + 5].value as boolean,
        isEditable: rawResults[baseIndex + 6].value as boolean,
        baseURI: rawResults[baseIndex + 7].value as string,
        chainId: POLYGON_CHAIN_ID,
      });
    }
  } catch (e: any) {
    // Log only the message: RPC errors can embed the endpoint URL (with API key).
    console.error(`❌ Multicall failed completely, will use fallback: ${e.message}`);
    return new Map();
  }

  return results;
}

/**
 * Read collection data with individual eth_calls, for the range where Multicall3 does not exist
 * yet (Polygon below POLYGON_MULTICALL_CREATION_BLOCK).
 *
 * Collections are read CONCURRENTLY. They used to be read one after another inside the handler
 * loop, which has to stay sequential because every handleCollectionCreation read-modify-writes
 * shared storedData across awaits. That constraint applies to the state mutation, not to the
 * reads: doing them here first leaves the loop pure in-memory and lets the calls overlap. On a
 * from-scratch reindex the serialized version was the single largest term in a batch — 50s of a
 * 65s batch, more than the DB reads and writes combined.
 *
 * Each collection is read at ITS OWN creation block, exactly as the per-collection fallback in
 * handleCollectionCreation does. That is stricter than the multicall path, which reads the whole
 * batch at the batch's last block: owner/isCompleted/isApproved/isEditable are mutable, so the
 * two are not interchangeable and this path keeps the stricter one.
 *
 * A collection whose reads fail is omitted rather than throwing — the caller still has the
 * per-collection fallback.
 */
export async function fetchCollectionDataDirect(
  ctx: Context,
  collections: { address: string; blockHeader: Block }[]
): Promise<Map<string, CollectionData>> {
  const results = new Map<string, CollectionData>();
  if (collections.length === 0) {
    return results;
  }

  const start = performance.now();

  for (let i = 0; i < collections.length; i += DIRECT_FETCH_CONCURRENCY) {
    const chunk = collections.slice(i, i + DIRECT_FETCH_CONCURRENCY);
    const settled = await Promise.allSettled(
      chunk.map(({ address, blockHeader }) =>
        readCollection(ctx, blockHeader, address)
      )
    );

    settled.forEach((outcome, j) => {
      if (outcome.status === "fulfilled") {
        results.set(outcome.value.address, outcome.value);
      } else {
        // Message only, and never the rejection value itself: RPC errors can embed the
        // endpoint URL (with API key), and a library is free to reject with a bare string.
        console.log(
          `⚠️ Direct read failed for collection ${chunk[j].address.slice(
            0,
            10
          )}, will use fallback: ${outcome.reason?.message ?? "unknown error"}`
        );
      }
    });
  }

  console.log(
    `✅ Direct read of ${results.size}/${collections.length} collections (${
      results.size * CALLS_PER_COLLECTION
    } calls): ${fmt(performance.now() - start)}`
  );

  return results;
}

async function readCollection(
  ctx: Context,
  blockHeader: Block,
  address: string
): Promise<CollectionData> {
  const contract = new CollectionV2Contract(ctx, blockHeader, address);
  const [
    name,
    symbol,
    owner,
    creator,
    isCompleted,
    isApproved,
    isEditable,
    baseURI,
  ] = await Promise.all([
    contract.name(),
    contract.symbol(),
    contract.owner(),
    contract.creator(),
    contract.isCompleted(),
    contract.isApproved(),
    contract.isEditable(),
    contract.baseURI(),
  ]);

  return {
    address: address.toLowerCase(),
    name,
    symbol,
    owner: owner.toLowerCase(),
    creator: creator.toLowerCase(),
    isCompleted,
    isApproved,
    isEditable,
    baseURI,
    chainId: POLYGON_CHAIN_ID,
  };
}
