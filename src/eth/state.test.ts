import type { BlockData, Context } from "./processor";
import {
  beginOffChainMarketplaceFeeBatch,
  endOffChainMarketplaceFeeBatch,
  getOffChainMarketplaceFeeRate,
  resetOffChainMarketplaceContractData,
  setOffChainMarketplaceFeeRate,
} from "./state";

// The chain read behind a cold-cache seed. Replaced per test so a fake can answer by block height.
jest.mock("../abi/DecentralandMarketplaceEthereum", () => ({
  ...jest.requireActual("../abi/DecentralandMarketplaceEthereum"),
  Contract: jest.fn(),
}));
const { Contract: ContractMock } = jest.requireMock(
  "../abi/DecentralandMarketplaceEthereum"
) as { Contract: jest.Mock };

/**
 * Ethereum used to read feeRate() over RPC per trade, at the trade's OWN block. State at N is
 * post-block, so a rate update later in N priced a trade earlier in it with the new rate. These pin
 * the two halves of the fix: the seed reads N-1, and updates are replayed where they sit in the order.
 */
const V2 = "0x1b67d0e31eeb6b52d8eeed71d3616c2f5b33b8e7";
const V3 = "0x0f11d0d1671519683bd48abf3dbe779e300941cd";
const N = 25_900_000;

const ctx = {} as unknown as Context;
const blockAt = (height: number) =>
  ({ header: { height } } as unknown as BlockData);

describe("getOffChainMarketplaceFeeRate", () => {
  beforeEach(() => {
    resetOffChainMarketplaceContractData();
    ContractMock.mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("when the cache is cold and a rate update lands later in the trade's block", () => {
    let seenHeights: number[];
    let feeRate: bigint;

    beforeEach(async () => {
      seenHeights = [];
      // State at N is post-block and already holds the update; state at N-1 does not.
      ContractMock.mockImplementation((_ctx: unknown, block: { height: number }) => {
        seenHeights.push(block.height);
        return {
          feeRate: async () => (block.height >= N ? BigInt(40000) : BigInt(25000)),
        };
      });
      feeRate = await getOffChainMarketplaceFeeRate(ctx, blockAt(N), V3);
    });

    it("should read the block before the trade's, so the later update is not in the state it sees", () => {
      expect(seenHeights).toEqual([N - 1]);
    });

    it("should give the trade the rate in force before the block", () => {
      expect(feeRate).toBe(BigInt(25000));
    });
  });

  describe("when a batch holds a trade, a rate update and another trade, in that order", () => {
    let beforeUpdate: bigint;
    let afterUpdate: bigint;

    beforeEach(async () => {
      ContractMock.mockImplementation(() => ({
        feeRate: async () => BigInt(25000),
      }));
      beginOffChainMarketplaceFeeBatch(N);
      // Replayed the way the second pass does: each entry is handled when its position is reached.
      beforeUpdate = await getOffChainMarketplaceFeeRate(ctx, blockAt(N), V3);
      setOffChainMarketplaceFeeRate(V3, BigInt(40000));
      afterUpdate = await getOffChainMarketplaceFeeRate(ctx, blockAt(N), V3);
    });

    it("should give the trade before the update the rate that was in force", () => {
      expect(beforeUpdate).toBe(BigInt(25000));
    });

    it("should give the trade after the update the new rate", () => {
      expect(afterUpdate).toBe(BigInt(40000));
    });
  });

  describe("when one marketplace's rate changes", () => {
    let other: bigint;

    beforeEach(async () => {
      ContractMock.mockImplementation(() => ({
        feeRate: async () => BigInt(25000),
      }));
      beginOffChainMarketplaceFeeBatch(N);
      setOffChainMarketplaceFeeRate(V3, BigInt(40000));
      other = await getOffChainMarketplaceFeeRate(ctx, blockAt(N), V2);
    });

    it("should leave every other version on its own rate", () => {
      expect(other).toBe(BigInt(25000));
    });
  });

  describe("when a batch's writes are still open", () => {
    let afterRetry: bigint;

    beforeEach(async () => {
      ContractMock.mockImplementation(() => ({
        feeRate: async () => BigInt(25000),
      }));
      // The batch raises the rate and ends, but the range comes back: its writes never committed.
      beginOffChainMarketplaceFeeBatch(N);
      setOffChainMarketplaceFeeRate(V3, BigInt(40000));
      endOffChainMarketplaceFeeBatch(N + 100);
      beginOffChainMarketplaceFeeBatch(N);
      afterRetry = await getOffChainMarketplaceFeeRate(ctx, blockAt(N), V3);
    });

    it("should not let the retry read a rate the failed attempt learned", () => {
      expect(afterRetry).toBe(BigInt(25000));
    });
  });

  describe("when the cache is cold and the chain read fails", () => {
    let read: Promise<bigint>;

    beforeEach(() => {
      ContractMock.mockImplementation(() => ({
        feeRate: async () => {
          throw new Error("RPC unavailable");
        },
      }));
      read = getOffChainMarketplaceFeeRate(ctx, blockAt(N), V3);
    });

    // The rate lands in a Sale's money column, so a swallowed read would record a sale with no fee.
    it("should reject rather than hand back a rate it never read", async () => {
      await expect(read).rejects.toThrow("RPC unavailable");
    });
  });
});
