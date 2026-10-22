// Indexes for the lookups the subgraph gateway and the history send, which no generated index covers:
// - an item by its URN (`items(where: { urn_in })`);
// - a parcel by its coordinates (`parcels(where: { x, y })`);
// - a name's owner by its name in any case (`name_starts_with_nocase` + `name_ends_with_nocase`,
//   and marketplace-api's name lookups), only over names;
// - a NFT's transfers in block order, which the owner of a NFT at a past block reads.
//
// None of them is on the processors' write path, so src/common/utils/indexManager.ts drops them during
// a backfill and creates them again at the chain head, like the other query-layer indexes.
//
// The name index uses `text_pattern_ops`, so it serves the prefix lookups the API prints for
// `name_starts_with_nocase` (`starts_with(lower(name), ...)`) as well as equality, without changing the
// column's collation.
//
// These indexes are not declared in schema.graphql, so `squid-typeorm-migration generate` writes a
// DROP INDEX for each in the next generated migration: remove those lines from it.
module.exports = class GatewayIndexes1792700000000 {
    name = 'GatewayIndexes1792700000000'

    async up(db) {
        await db.query(`CREATE INDEX "IDX_item_urn" ON "item" ("urn")`)
        await db.query(`CREATE INDEX "IDX_parcel_x_y" ON "parcel" ("x", "y")`)
        await db.query(`CREATE INDEX "IDX_nft_ens_lower_name" ON "nft" (lower("name") text_pattern_ops) WHERE "category" = 'ens'`)
        await db.query(`CREATE INDEX "IDX_transfer_nft_block" ON "transfer" ("nft_id", "block")`)
    }

    async down(db) {
        await db.query(`DROP INDEX "IDX_transfer_nft_block"`)
        await db.query(`DROP INDEX "IDX_nft_ens_lower_name"`)
        await db.query(`DROP INDEX "IDX_parcel_x_y"`)
        await db.query(`DROP INDEX "IDX_item_urn"`)
    }
}
