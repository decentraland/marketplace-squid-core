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

/**
 * Walks into containers as well as top-level exports: Polygon keeps `CreditsManager` as an array of
 * addresses and Ethereum keeps `collections` as an object of them, and an address is just as
 * comparable from inside one of those.
 */
const findAddresses = (value: unknown, path: string): [string, string][] => {
  if (typeof value === "string") {
    return value.startsWith("0x") ? [[path, value]] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findAddresses(item, `${path}[${index}]`));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) =>
      findAddresses(item, path ? `${path}.${key}` : key)
    );
  }
  return [];
};

describe("contract address files", () => {
  for (const [name, file] of Object.entries(addressFiles)) {
    it(`should hold every ${name} address lowercase, since log addresses are compared exactly`, () => {
      const offending = findAddresses(file, "")
        .filter(([, address]) => !LOWERCASE_ADDRESS.test(address))
        .map(([exportPath, address]) => `${exportPath}=${address}`);

      assert.deepEqual(offending, []);
    });
  }

  it("should reach the addresses held inside containers, not just the top-level exports", () => {
    const reached = findAddresses(addressFiles, "").length;
    const topLevelOnly = Object.values(addressFiles)
      .flatMap((file) => Object.values(file))
      .filter((value) => typeof value === "string" && value.startsWith("0x")).length;

    assert.ok(
      reached > topLevelOnly,
      `expected the walk to reach more than the ${topLevelOnly} top-level addresses, got ${reached}`
    );
  });
});
