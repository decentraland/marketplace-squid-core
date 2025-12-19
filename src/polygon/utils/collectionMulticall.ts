import { Multicall } from "../../abi/multicall";
import { functions as CollectionV2Functions } from "../abi/CollectionV2";

const MULTICALL_CONTRACT = "0xcA11bde05977b3631167028862bE2a173976CA11";
// Multicall3 on Polygon was deployed at block 25770160 (Jan 2022)
// But we're indexing from much later, so it's always available
export const POLYGON_MULTICALL_CREATION_BLOCK = 25770160;

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
 * This reduces 9 RPC calls per collection to 1 batch call for ALL collections
 */
export async function fetchCollectionDataMulticall(
  ctx: any,
  blockHeader: any,
  collectionAddresses: string[]
): Promise<Map<string, CollectionData>> {
  if (collectionAddresses.length === 0) {
    return new Map();
  }

  // Check if we're past the multicall creation block
  if (blockHeader.height < POLYGON_MULTICALL_CREATION_BLOCK) {
    console.log(`⚠️ Block ${blockHeader.height} is before multicall creation, falling back to individual calls`);
    return new Map(); // Caller will use fallback
  }

  const multicall = new Multicall(ctx, blockHeader, MULTICALL_CONTRACT);
  const results = new Map<string, CollectionData>();

  // Build all calls: 9 functions x N collections
  const calls: [any, string, any][] = [];
  
  for (const address of collectionAddresses) {
    calls.push([CollectionV2Functions.name, address, {}]);
    calls.push([CollectionV2Functions.symbol, address, {}]);
    calls.push([CollectionV2Functions.owner, address, {}]);
    calls.push([CollectionV2Functions.creator, address, {}]);
    calls.push([CollectionV2Functions.isCompleted, address, {}]);
    calls.push([CollectionV2Functions.isApproved, address, {}]);
    calls.push([CollectionV2Functions.isEditable, address, {}]);
    calls.push([CollectionV2Functions.baseURI, address, {}]);
    calls.push([CollectionV2Functions.getChainId, address, {}]);
  }

  const multicallStart = performance.now();
  
  try {
    // Use tryAggregate to handle individual failures gracefully
    const rawResults = await multicall.tryAggregate(calls, 100); // Page size of 100
    
    const multicallDuration = performance.now() - multicallStart;
    const fmt = (ms: number) => ms >= 1000 ? `${(ms/1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
    console.log(`✅ Multicall for ${collectionAddresses.length} collections (${calls.length} calls): ${fmt(multicallDuration)}`);

    // Parse results: 9 results per collection
    for (let i = 0; i < collectionAddresses.length; i++) {
      const address = collectionAddresses[i].toLowerCase();
      const baseIndex = i * 9;

      // Check if all calls succeeded
      const allSuccess = rawResults.slice(baseIndex, baseIndex + 9).every(r => r.success);
      
      if (!allSuccess) {
        console.log(`⚠️ Multicall failed for collection ${address.slice(0, 10)}, will use fallback`);
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
        chainId: rawResults[baseIndex + 8].value as bigint,
      });
    }
  } catch (e) {
    console.error(`❌ Multicall failed completely, will use fallback:`, e);
    return new Map();
  }

  return results;
}



