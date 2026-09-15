import assert from "node:assert";
import { describe, it } from "node:test";
import * as ethMainnet from "../../eth/addresses/mainnet";
import * as ethSepolia from "../../eth/addresses/sepolia";
import * as polygonAmoy from "../../polygon/addresses/amoy";
import * as polygonMainnet from "../../polygon/addresses/mainnet";

/**
 * Log addresses arrive lowercase and the processors compare them with `===`, so a checksummed entry
 * in an address file is a comparison that can never be true, and it fails silently: the batch
 * relevance check decides the batch holds nothing and drops it, and `isMarketplaceV1` reports false
 * for the very contract it was asked about.
 */
const addressFiles: Record<string, Record<string, unknown>> = {
  "eth/mainnet": ethMainnet,
  "eth/sepolia": ethSepolia,
  "polygon/mainnet": polygonMainnet,
  "polygon/amoy": polygonAmoy,
};

const LOWERCASE_ADDRESS = /^0x[0-9a-f]{40}$/;

describe("contract address files", () => {
  for (const [name, file] of Object.entries(addressFiles)) {
    it(`should hold every ${name} address lowercase, since log addresses are compared exactly`, () => {
      const offending = Object.entries(file)
        .filter(
          (entry): entry is [string, string] =>
            typeof entry[1] === "string" && entry[1].startsWith("0x")
        )
        .filter(([, address]) => !LOWERCASE_ADDRESS.test(address))
        .map(([exportName, address]) => `${exportName}=${address}`);

      assert.deepEqual(offending, []);
    });
  }
});
