/**
 * Index Manager - Drop/Recreate indices for faster bulk indexing
 * 
 * During initial sync, maintaining indices is expensive.
 * We drop non-essential indices and recreate them when caught up.
 */

import { EntityManager } from 'typeorm';

// Indices to drop during bulk indexing
// IMPORTANT: Do NOT include:
// - Primary Keys (PK_*)
// - UNIQUE constraints that support Foreign Keys (REL_*, IDX_* for parcel_id, estate_id, etc.)
// - Any index that has a constraint depending on it
// Grouped by priority - heaviest tables first
export const DROPPABLE_INDICES = {
  // NFT - heaviest table, most indices (excluding FK constraint indices)
  nft: [
    { name: 'IDX_5f8cc4778564d0bd3c4ac3436d', create: `CREATE INDEX "IDX_5f8cc4778564d0bd3c4ac3436d" ON "nft" ("search_order_status", "search_order_expires_at", "category")` },
    { name: 'IDX_d5b8837a62eb6d9c95eb3d2ef2', create: `CREATE INDEX "IDX_d5b8837a62eb6d9c95eb3d2ef2" ON "nft" ("search_order_status", "search_order_expires_at", "network")` },
    { name: 'IDX_26e756121a20d1cc3e4d738279', create: `CREATE INDEX "IDX_26e756121a20d1cc3e4d738279" ON "nft" ("owner_address")` },
    { name: 'IDX_0fca1a8c5d9399d9a9a52e26f7', create: `CREATE INDEX "IDX_0fca1a8c5d9399d9a9a52e26f7" ON "nft" ("contract_address", "token_id")` },
    { name: 'IDX_3baa214ec3db0ce29708750e3b', create: `CREATE INDEX "IDX_3baa214ec3db0ce29708750e3b" ON "nft" ("category")` },
    { name: 'IDX_e0e405184c1c9253bbe95b6cc7', create: `CREATE INDEX "IDX_e0e405184c1c9253bbe95b6cc7" ON "nft" ("search_order_expires_at_normalized")` },
    { name: 'IDX_b53fdf02d6f6047c1758ae885a', create: `CREATE INDEX "IDX_b53fdf02d6f6047c1758ae885a" ON "nft" ("search_is_land")` },
    { name: 'IDX_4c7d1118621f3ea97740a1d876', create: `CREATE INDEX "IDX_4c7d1118621f3ea97740a1d876" ON "nft" ("item_id", "owner_id")` },
    { name: 'IDX_2c8ca873555fc156848199919f', create: `CREATE INDEX "IDX_2c8ca873555fc156848199919f" ON "nft" ("created_at")` },
    { name: 'IDX_645ec1a1710c449fa4e9d241e9', create: `CREATE INDEX "IDX_645ec1a1710c449fa4e9d241e9" ON "nft" ("search_order_expires_at")` },
    { name: 'IDX_4d213d73326e54427a5c9bdddf', create: `CREATE INDEX "IDX_4d213d73326e54427a5c9bdddf" ON "nft" ("search_parcel_is_in_bounds")` },
    { name: 'IDX_7e215df412b248db3731737290', create: `CREATE INDEX "IDX_7e215df412b248db3731737290" ON "nft" ("token_id")` },
    { name: 'IDX_ffe58aa05707db77c2f20ecdbc', create: `CREATE INDEX "IDX_ffe58aa05707db77c2f20ecdbc" ON "nft" ("collection_id")` },
    { name: 'IDX_c36d2ea36d7de5e265c30b8be8', create: `CREATE INDEX "IDX_c36d2ea36d7de5e265c30b8be8" ON "nft" ("metadata_id")` },
    { name: 'IDX_83cfd3a290ed70c660f8c9dfe2', create: `CREATE INDEX "IDX_83cfd3a290ed70c660f8c9dfe2" ON "nft" ("owner_id")` },
    { name: 'IDX_b92ac830e4b3a630162a898203', create: `CREATE INDEX "IDX_b92ac830e4b3a630162a898203" ON "nft" ("active_order_id")` },
    // NOTE: IDX/REL for parcel_id, estate_id, wearable_id, ens_id are FK constraints - cannot drop!
  ],
  
  // Order - second heaviest
  order: [
    { name: 'IDX_2485593ed8c9972197aeaf7da6', create: `CREATE INDEX "IDX_2485593ed8c9972197aeaf7da6" ON "order" ("expires_at_normalized")` },
    { name: 'IDX_d01158fe15b1ead5c26fd7f4e9', create: `CREATE INDEX "IDX_d01158fe15b1ead5c26fd7f4e9" ON "order" ("item_id")` },
    { name: 'IDX_f5047ff046d513a3598c1a2931', create: `CREATE INDEX "IDX_f5047ff046d513a3598c1a2931" ON "order" ("nft_id")` },
  ],
  
  // Sale
  sale: [
    { name: 'IDX_8ac00a610840894296c6f32fd2', create: `CREATE INDEX "IDX_8ac00a610840894296c6f32fd2" ON "sale" ("timestamp")` },
    { name: 'IDX_a91d7a7aa55af7d57ef4d17912', create: `CREATE INDEX "IDX_a91d7a7aa55af7d57ef4d17912" ON "sale" ("search_category", "network")` },
    { name: 'IDX_439a57a4a0d130329d3d2e671b', create: `CREATE INDEX "IDX_439a57a4a0d130329d3d2e671b" ON "sale" ("item_id")` },
    { name: 'IDX_8524438f82167bcb795bcb8663', create: `CREATE INDEX "IDX_8524438f82167bcb795bcb8663" ON "sale" ("nft_id")` },
  ],
  
  // Item
  item: [
    { name: 'IDX_9ddbd0267ddb9c59621775f94e', create: `CREATE INDEX "IDX_9ddbd0267ddb9c59621775f94e" ON "item" ("collection_id", "blockchain_id")` },
    { name: 'IDX_6d5bb320c601281cd3a213979e', create: `CREATE INDEX "IDX_6d5bb320c601281cd3a213979e" ON "item" ("metadata_id")` },
  ],
  
  // Bid
  bid: [
    { name: 'IDX_3caf2d6b31d2fe45a2b85b8191', create: `CREATE INDEX "IDX_3caf2d6b31d2fe45a2b85b8191" ON "bid" ("nft_id")` },
  ],
  
  // Transfer - lots of records
  transfer: [
    { name: 'IDX_024eb30e5fd99a5bea7befe60e', create: `CREATE INDEX "IDX_024eb30e5fd99a5bea7befe60e" ON "transfer" ("network")` },
    { name: 'IDX_c116ab40c3b32ca2d9c1d17d8b', create: `CREATE INDEX "IDX_c116ab40c3b32ca2d9c1d17d8b" ON "transfer" ("block")` },
    { name: 'IDX_be54ea276e0f665ffc38630fc0', create: `CREATE INDEX "IDX_be54ea276e0f665ffc38630fc0" ON "transfer" ("from")` },
    { name: 'IDX_4cbc37e8c3b47ded161f44c24f', create: `CREATE INDEX "IDX_4cbc37e8c3b47ded161f44c24f" ON "transfer" ("to")` },
    { name: 'IDX_f605a03972b4f28db27a0ee70d', create: `CREATE INDEX "IDX_f605a03972b4f28db27a0ee70d" ON "transfer" ("tx_hash")` },
  ],
  
  // Mint
  mint: [
    { name: 'IDX_cd587534d4140377bb52337ae4', create: `CREATE INDEX "IDX_cd587534d4140377bb52337ae4" ON "mint" ("item_id")` },
    { name: 'IDX_c46ca4e5f135d6dbdf10111660', create: `CREATE INDEX "IDX_c46ca4e5f135d6dbdf10111660" ON "mint" ("nft_id")` },
  ],
  
  // Curation
  curation: [
    { name: 'IDX_dff9f3d4753a2a4caecf74d066', create: `CREATE INDEX "IDX_dff9f3d4753a2a4caecf74d066" ON "curation" ("curator_id")` },
    { name: 'IDX_2cb014ad08eee6a3c64afa42f3', create: `CREATE INDEX "IDX_2cb014ad08eee6a3c64afa42f3" ON "curation" ("collection_id")` },
    { name: 'IDX_ddf35815bd940a989480f79fec', create: `CREATE INDEX "IDX_ddf35815bd940a989480f79fec" ON "curation" ("item_id")` },
  ],
  
  // Metadata
  metadata: [
    { name: 'IDX_45072545bb44e246e0496110f9', create: `CREATE INDEX "IDX_45072545bb44e246e0496110f9" ON "metadata" ("wearable_id")` },
    { name: 'IDX_cee9cecc2205cd07a21813203d', create: `CREATE INDEX "IDX_cee9cecc2205cd07a21813203d" ON "metadata" ("emote_id")` },
  ],
  
  // Estate
  estate: [
    { name: 'IDX_1f3ec6150afbb8a3fd75fae814', create: `CREATE INDEX "IDX_1f3ec6150afbb8a3fd75fae814" ON "estate" ("size")` },
    { name: 'IDX_0b680d37990796da3232ad9d98', create: `CREATE INDEX "IDX_0b680d37990796da3232ad9d98" ON "estate" ("owner_id")` },
    { name: 'IDX_c40a1b5f5b764ad6ab5fa749cd', create: `CREATE INDEX "IDX_c40a1b5f5b764ad6ab5fa749cd" ON "estate" ("data_id")` },
  ],
  
  // Parcel
  parcel: [
    { name: 'IDX_a7c5c87cd4ffc1e1129f0c5f43', create: `CREATE INDEX "IDX_a7c5c87cd4ffc1e1129f0c5f43" ON "parcel" ("owner_id")` },
    { name: 'IDX_da4912d77606dcfabe5da7eebc', create: `CREATE INDEX "IDX_da4912d77606dcfabe5da7eebc" ON "parcel" ("estate_id")` },
    { name: 'IDX_04ab2b996d659d2f86dbcee860', create: `CREATE INDEX "IDX_04ab2b996d659d2f86dbcee860" ON "parcel" ("data_id")` },
  ],
  
  // Data
  data: [
    { name: 'IDX_8694618f20c7b364d4cb23c111', create: `CREATE INDEX "IDX_8694618f20c7b364d4cb23c111" ON "data" ("parcel_id")` },
    { name: 'IDX_ae7e5532f8406258419ed617b4', create: `CREATE INDEX "IDX_ae7e5532f8406258419ed617b4" ON "data" ("estate_id")` },
  ],
  
  // Wearable
  wearable: [
    { name: 'IDX_f011ccea27833b0628a7532834', create: `CREATE INDEX "IDX_f011ccea27833b0628a7532834" ON "wearable" ("owner_id")` },
  ],
  
  // ENS
  ens: [
    { name: 'IDX_2ebf256442a48f5acbdf2ea77d', create: `CREATE INDEX "IDX_2ebf256442a48f5acbdf2ea77d" ON "ens" ("owner_id")` },
    { name: 'IDX_ens_order_hash', create: `CREATE INDEX "IDX_ens_order_hash" ON "ens" ("order_hash")` },
  ],
  
  // Account
  account: [
    { name: 'IDX_83603c168bc00b20544539fbea', create: `CREATE INDEX "IDX_83603c168bc00b20544539fbea" ON "account" ("address")` },
  ],
  
  // SquidRouterOrder
  squid_router_order: [
    { name: 'IDX_squid_router_order_order_hash', create: `CREATE INDEX "IDX_squid_router_order_order_hash" ON "squid_router_order" ("order_hash")` },
    { name: 'IDX_squid_router_order_tx_hash', create: `CREATE INDEX "IDX_squid_router_order_tx_hash" ON "squid_router_order" ("tx_hash")` },
  ],
};

// Get all indices as a flat array
export function getAllIndices(): { name: string; create: string }[] {
  return Object.values(DROPPABLE_INDICES).flat();
}

// State tracking
let indicesDropped = false;
let isNearHead = false;

/**
 * Check if we're near the chain head (within threshold blocks)
 */
export function checkIfNearHead(currentBlock: number, chainHead: number, threshold = 100): boolean {
  isNearHead = chainHead - currentBlock <= threshold;
  return isNearHead;
}

/**
 * Drop all non-essential indices for faster bulk loading
 * Note: We drop indices one by one to avoid transaction abort issues
 */
export async function dropIndicesForBulkLoad(em: EntityManager): Promise<void> {
  if (indicesDropped) {
    console.log('⚡ Indices already dropped, skipping...');
    return;
  }
  
  const indices = getAllIndices();
  console.log(`⚡ BULK MODE: Dropping ${indices.length} indices for faster indexing...`);
  
  const startTime = performance.now();
  let dropped = 0;
  let skipped = 0;
  let transactionAborted = false;
  
  for (const idx of indices) {
    // If transaction is already aborted, just count as skipped
    if (transactionAborted) {
      skipped++;
      continue;
    }
    
    try {
      await em.query(`DROP INDEX IF EXISTS "${idx.name}"`);
      dropped++;
    } catch (e: any) {
      // Check if this is a constraint dependency error
      if (e.message.includes('requires it') || e.message.includes('constraint')) {
        console.log(`   ⚠️ ${idx.name} is a constraint, cannot drop`);
        skipped++;
        // This might abort the transaction
        if (e.message.includes('transaction is aborted')) {
          transactionAborted = true;
        }
      } else if (e.message.includes('transaction is aborted')) {
        // Transaction was aborted by a previous error
        transactionAborted = true;
        skipped++;
      } else {
        console.log(`   ⚠️ Could not drop ${idx.name}: ${e.message}`);
        skipped++;
      }
    }
  }
  
  const duration = performance.now() - startTime;
  if (transactionAborted) {
    console.log(`⚡ ⚠️ Transaction was aborted after dropping ${dropped} indices. This is OK - indices will be dropped on next restart.`);
  } else {
    console.log(`⚡ Dropped ${dropped} indices (${skipped} skipped) in ${(duration/1000).toFixed(1)}s`);
  }
  indicesDropped = dropped > 0;
}

/**
 * Recreate all indices (call when caught up with chain head)
 * Note: We use regular CREATE INDEX (not CONCURRENTLY) because we're inside a transaction
 */
export async function recreateIndices(em: EntityManager): Promise<void> {
  if (!indicesDropped) {
    console.log('⚡ Indices were not dropped, skipping recreation...');
    return;
  }
  
  const indices = getAllIndices();
  console.log(`⚡ CAUGHT UP: Recreating ${indices.length} indices...`);
  
  const startTime = performance.now();
  let created = 0;
  let skipped = 0;
  let failed = 0;
  let transactionAborted = false;
  
  for (const idx of indices) {
    // If transaction is already aborted, just count as failed
    if (transactionAborted) {
      failed++;
      continue;
    }
    
    try {
      // Note: Cannot use CONCURRENTLY inside a transaction block
      // Using regular CREATE INDEX IF NOT EXISTS
      const createStatement = idx.create.replace('CREATE INDEX', 'CREATE INDEX IF NOT EXISTS')
                                        .replace('CREATE UNIQUE INDEX', 'CREATE UNIQUE INDEX IF NOT EXISTS');
      await em.query(createStatement);
      created++;
      if (created % 10 === 0) {
        console.log(`   ✅ Created ${created}/${indices.length} indices...`);
      }
    } catch (e: any) {
      // Index might already exist
      if (e.message.includes('already exists')) {
        skipped++;
      } else if (e.message.includes('transaction is aborted')) {
        transactionAborted = true;
        failed++;
        console.log(`   ⚠️ Transaction aborted, cannot create remaining indices`);
      } else {
        console.log(`   ⚠️ Could not create ${idx.name}: ${e.message}`);
        failed++;
      }
    }
  }
  
  const duration = performance.now() - startTime;
  if (transactionAborted) {
    console.log(`⚡ ⚠️ Transaction was aborted. Created ${created} indices, ${skipped} already existed, ${failed} failed.`);
    console.log(`   Indices will be recreated on next restart or can be created manually.`);
  } else {
    console.log(`⚡ Created ${created} indices (${skipped} already existed, ${failed} failed) in ${(duration/1000).toFixed(1)}s`);
  }
  indicesDropped = false;
}

/**
 * Get current state
 */
export function getIndexState(): { indicesDropped: boolean; isNearHead: boolean } {
  return { indicesDropped, isNearHead };
}

/**
 * Check if an index exists
 */
export async function indexExists(em: EntityManager, indexName: string): Promise<boolean> {
  const result = await em.query(`
    SELECT 1 FROM pg_indexes 
    WHERE indexname = $1
  `, [indexName]);
  return result.length > 0;
}

/**
 * Get count of existing indices
 */
export async function countExistingIndices(em: EntityManager): Promise<number> {
  const indices = getAllIndices();
  let count = 0;
  for (const idx of indices) {
    if (await indexExists(em, idx.name)) {
      count++;
    }
  }
  return count;
}

