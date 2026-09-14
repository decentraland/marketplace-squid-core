import * as OffChainMarketplaceABI from "../abi/DecentralandMarketplacePolygon";
import type { Block, BlockData, Context } from "../processor";
import {
  getOffChainMarketplaceContractData,
  offChainMarketplaceContractData,
  setOffChainMarketplaceFeeCollector,
  setOffChainMarketplaceFeeRate,
  setOffChainMarketplaceRoyaltiesRate,
} from "../state";
import {
  applyFeeUpdate,
  FeeUpdateEventArgs,
  queueFeeUpdate,
  QueuedFeeUpdate,
} from "./feeUpdates";

/**
 * The batch's first pass sees every log before the second pass handles any trade, so a fee update
 * applied on sight would give every trade in the batch the LAST configuration. These pin the fix: the
 * update is queued with its position and applied when the second pass reaches it, so a trade before
 * the change reads the old value and a trade after it reads the new one.
 */
const V2 = "0xa40b1d129b8906888720686f3a01921ddf37716f";
const V3 = "0xe38ef22abe871513555cba89adfe45ab4f548ada";
const CALLER = "0x0e659a116e161d8e502f9036babda51334f2667e";
const COMMITTEE_MULTISIG = "0xb08e3e7cc815213304d884c88ca476ebc50eaab2";
const FEE_COLLECTOR_SAFE = "0x184e4d9a26add0af1eafc145550e890a421f16d7";
const { FeeCollectorUpdated, FeeRateUpdated, Traded } = OffChainMarketplaceABI.events;

const pad = (hex: string) => "0x" + hex.replace(/^0x/, "").padStart(64, "0");
const word = (n: bigint) => n.toString(16).padStart(64, "0");

// A subsquid-shaped log carrying only what decode() and the cache read.
const feeLog = (address: string, topics: string[], data: string, logIndex: number) =>
  ({
    address,
    logIndex,
    transactionHash: "0x" + "ab".repeat(32),
    topics,
    data,
  }) as unknown as QueuedFeeUpdate["log"];

const feeRateUpdatedLog = (address: string, rate: bigint, logIndex: number) =>
  feeLog(address, [FeeRateUpdated.topic, pad(CALLER)], "0x" + word(rate), logIndex);

// A populated cache entry is returned without touching the chain, so no client is needed.
const ctx = {} as unknown as Context;
const block = { header: { height: 93_600_000 } } as unknown as BlockData;
const header = block.header as unknown as Block;

const seed = (address: string, feeCollector: string) => {
  setOffChainMarketplaceFeeCollector(address, feeCollector);
  setOffChainMarketplaceFeeRate(address, BigInt(25000));
  setOffChainMarketplaceRoyaltiesRate(address, BigInt(25000));
};

describe("applyFeeUpdate", () => {
  beforeEach(() => {
    offChainMarketplaceContractData.clear();
    seed(V2, COMMITTEE_MULTISIG);
    seed(V3, FEE_COLLECTOR_SAFE);
  });

  describe("when a batch holds a trade, a fee-rate update and another trade on one marketplace, in that order", () => {
    let beforeUpdate: Awaited<ReturnType<typeof getOffChainMarketplaceContractData>>;
    let afterUpdate: Awaited<ReturnType<typeof getOffChainMarketplaceContractData>>;
    let otherMarketplace: Awaited<ReturnType<typeof getOffChainMarketplaceContractData>>;

    beforeEach(async () => {
      // Replayed the way the second pass does: each entry is handled when its position is reached.
      beforeUpdate = await getOffChainMarketplaceContractData(ctx, header, V3);
      const queued = queueFeeUpdate(FeeRateUpdated.topic, feeRateUpdatedLog(V3, BigInt(40000), 2), block);
      applyFeeUpdate(queued!.topic, queued!.log, queued!.event);
      afterUpdate = await getOffChainMarketplaceContractData(ctx, header, V3);
      otherMarketplace = await getOffChainMarketplaceContractData(ctx, header, V2);
    });

    it("should give the trade before the update the rate that was in force", () => {
      expect(beforeUpdate.feeRate).toBe(BigInt(25000));
    });

    it("should give the trade after the update the new rate", () => {
      expect(afterUpdate.feeRate).toBe(BigInt(40000));
    });

    it("should leave the other marketplace's rate untouched", () => {
      expect(otherMarketplace.feeRate).toBe(BigInt(25000));
    });
  });

  describe("when the topic is not a fee update", () => {
    let handled: boolean;

    beforeEach(() => {
      handled = applyFeeUpdate(Traded.topic, { address: V3 }, {} as FeeUpdateEventArgs);
    });

    it("should report it as not handled and change nothing", () => {
      expect(handled).toBe(false);
    });
  });
});

describe("queueFeeUpdate", () => {
  describe("when the log is a fee-rate update", () => {
    let log: QueuedFeeUpdate["log"];
    let queued: QueuedFeeUpdate | null;

    beforeEach(() => {
      log = feeRateUpdatedLog(V3, BigInt(40000), 7);
      queued = queueFeeUpdate(FeeRateUpdated.topic, log, block);
    });

    it("should decode the new rate", () => {
      expect((queued?.event as OffChainMarketplaceABI.FeeRateUpdatedEventArgs)._feeRate).toBe(BigInt(40000));
    });

    it("should keep the emitting log, which is what places it in the batch", () => {
      expect(queued?.log).toBe(log);
    });

    it("should keep the block", () => {
      expect(queued?.block).toBe(block);
    });
  });

  describe("when the log is a fee-collector update", () => {
    let queued: QueuedFeeUpdate | null;

    beforeEach(() => {
      // Both parameters are indexed, so the collector travels in the topics and the data is empty.
      const log = feeLog(V3, [FeeCollectorUpdated.topic, pad(CALLER), pad(FEE_COLLECTOR_SAFE)], "0x", 3);
      queued = queueFeeUpdate(FeeCollectorUpdated.topic, log, block);
    });

    it("should decode the new collector", () => {
      expect(
        (queued?.event as OffChainMarketplaceABI.FeeCollectorUpdatedEventArgs)._feeCollector.toLowerCase()
      ).toBe(FEE_COLLECTOR_SAFE);
    });
  });

  describe("when the topic is anything else", () => {
    let queued: QueuedFeeUpdate | null;

    beforeEach(() => {
      queued = queueFeeUpdate(Traded.topic, feeRateUpdatedLog(V3, BigInt(1), 9), block);
    });

    it("should return null, leaving the log to its own handler", () => {
      expect(queued).toBeNull();
    });
  });
});
