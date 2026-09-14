import type { Block, Context } from "./processor";
import {
  beginOffChainMarketplaceFeeBatch,
  endOffChainMarketplaceFeeBatch,
  getOffChainMarketplaceContractData,
  resetOffChainMarketplaceContractData,
  setOffChainMarketplaceFeeCollector,
  setOffChainMarketplaceFeeRate,
  setOffChainMarketplaceRoyaltiesRate,
} from "./state";

// The chain read behind a cold-cache seed. Replaced per test so a fake can answer by block height.
jest.mock("./abi/DecentralandMarketplacePolygon", () => ({
  ...jest.requireActual("./abi/DecentralandMarketplacePolygon"),
  Contract: jest.fn(),
}));
const { Contract: ContractMock } = jest.requireMock(
  "./abi/DecentralandMarketplacePolygon"
) as { Contract: jest.Mock };

/**
 * Every marketplace version keeps its own fee configuration, and V3 on Polygon collects into a
 * different Safe than V1/V2. These pin that the cache is keyed by the emitting contract, that a cold
 * seed reads the state BEFORE the trade's block, and that a batch's writes reach the cache only once
 * the batch completes.
 */
const V1 = "0x540fb08edb56aae562864b390542c97f562825ba";
const V3 = "0xe38ef22abe871513555cba89adfe45ab4f548ada";
const COMMITTEE_MULTISIG = "0xb08e3e7cc815213304d884c88ca476ebc50eaab2";
const FEE_COLLECTOR_SAFE = "0x184e4d9a26add0af1eafc145550e890a421f16d7";
const N = 93_600_000;

const ctx = {} as unknown as Context;
const blockAt = (height: number) => ({ height } as unknown as Block);

const seed = (address: string, feeCollector: string) => {
  setOffChainMarketplaceFeeCollector(address, feeCollector);
  setOffChainMarketplaceFeeRate(address, BigInt(25000));
  setOffChainMarketplaceRoyaltiesRate(address, BigInt(25000));
};

type FeeConfig = Awaited<ReturnType<typeof getOffChainMarketplaceContractData>>;

describe("getOffChainMarketplaceContractData", () => {
  beforeEach(() => {
    resetOffChainMarketplaceContractData();
    ContractMock.mockReset();
    // The seed logs an INFO line; keep the test output to the assertions.
    jest.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("when two marketplaces have been configured through the update setters", () => {
    beforeEach(() => {
      seed(V1, COMMITTEE_MULTISIG);
      seed(V3, FEE_COLLECTOR_SAFE);
    });

    it("should resolve each marketplace to its own fee collector", async () => {
      const [v1, v3] = await Promise.all([
        getOffChainMarketplaceContractData(ctx, blockAt(N), V1),
        getOffChainMarketplaceContractData(ctx, blockAt(N), V3),
      ]);
      expect([v1.feeCollector, v3.feeCollector]).toEqual([COMMITTEE_MULTISIG, FEE_COLLECTOR_SAFE]);
    });

    describe("and the emitting address is spelled in a different case", () => {
      it("should resolve the same entry", async () => {
        const data = await getOffChainMarketplaceContractData(
          ctx,
          blockAt(N),
          V3.toUpperCase().replace("0X", "0x")
        );
        expect(data.feeCollector).toBe(FEE_COLLECTOR_SAFE);
      });
    });

    describe("and a fee update arrives from one of them", () => {
      beforeEach(() => {
        setOffChainMarketplaceFeeRate(V3, BigInt(40000));
      });

      it("should change only that marketplace's rate", async () => {
        const [v1, v3] = await Promise.all([
          getOffChainMarketplaceContractData(ctx, blockAt(N), V1),
          getOffChainMarketplaceContractData(ctx, blockAt(N), V3),
        ]);
        expect([v1.feeRate, v3.feeRate]).toEqual([BigInt(25000), BigInt(40000)]);
      });
    });
  });

  describe("when the cache is cold and a fee update lands later in the trade's block", () => {
    let seenHeights: number[];
    let data: FeeConfig;

    beforeEach(async () => {
      seenHeights = [];
      // State at N is post-block and already holds the update; state at N-1 does not.
      ContractMock.mockImplementation((_ctx: unknown, block: { height: number }) => {
        seenHeights.push(block.height);
        const rate = block.height >= N ? BigInt(40000) : BigInt(25000);
        return {
          feeCollector: async () => FEE_COLLECTOR_SAFE,
          feeRate: async () => rate,
          royaltiesRate: async () => BigInt(25000),
        };
      });
      data = await getOffChainMarketplaceContractData(ctx, blockAt(N), V3);
    });

    it("should read the block before the trade's, so the later update is not in the state it sees", () => {
      expect(seenHeights).toEqual([N - 1]);
    });

    it("should give the trade the rate in force before the block", () => {
      expect(data.feeRate).toBe(BigInt(25000));
    });
  });

  describe("when the cache is cold and an update earlier in the batch already set one field", () => {
    let data: FeeConfig;

    beforeEach(async () => {
      beginOffChainMarketplaceFeeBatch(N);
      setOffChainMarketplaceFeeRate(V3, BigInt(40000));
      ContractMock.mockImplementation(() => ({
        feeCollector: async () => FEE_COLLECTOR_SAFE,
        feeRate: async () => BigInt(25000),
        royaltiesRate: async () => BigInt(25000),
      }));
      data = await getOffChainMarketplaceContractData(ctx, blockAt(N), V3);
    });

    it("should keep the replayed rate rather than overwrite it with the chain read", () => {
      expect(data.feeRate).toBe(BigInt(40000));
    });

    it("should still seed the fields nothing changed from the chain", () => {
      expect(data.feeCollector).toBe(FEE_COLLECTOR_SAFE);
    });
  });

  describe("when a batch with a trade before a fee update is retried after failing", () => {
    let firstAttempt: FeeConfig;
    let retry: FeeConfig;

    beforeEach(async () => {
      seed(V3, FEE_COLLECTOR_SAFE);
      // Batch 100-200: the trade is handled, then the update, then the batch ends — but the store never
      // commits, so the processor hands the same range back.
      beginOffChainMarketplaceFeeBatch(100);
      firstAttempt = await getOffChainMarketplaceContractData(ctx, blockAt(100), V3);
      setOffChainMarketplaceFeeRate(V3, BigInt(40000));
      endOffChainMarketplaceFeeBatch(200);
      beginOffChainMarketplaceFeeBatch(100);
      retry = await getOffChainMarketplaceContractData(ctx, blockAt(100), V3);
    });

    it("should give the trade the same rate on the retry as on the first attempt", () => {
      expect([firstAttempt.feeRate, retry.feeRate]).toEqual([BigInt(25000), BigInt(25000)]);
    });
  });

  describe("when a batch stages a fee update and the next batch starts past it", () => {
    let data: FeeConfig;

    beforeEach(async () => {
      seed(V3, FEE_COLLECTOR_SAFE);
      beginOffChainMarketplaceFeeBatch(100);
      setOffChainMarketplaceFeeRate(V3, BigInt(40000));
      endOffChainMarketplaceFeeBatch(200);
      beginOffChainMarketplaceFeeBatch(201);
      data = await getOffChainMarketplaceContractData(ctx, blockAt(201), V3);
    });

    it("should promote the value, since the processor only moves past a batch it committed", () => {
      expect(data.feeRate).toBe(BigInt(40000));
    });
  });

  describe("when a batch throws before ending and the same range is retried", () => {
    let data: FeeConfig;

    beforeEach(async () => {
      seed(V3, FEE_COLLECTOR_SAFE);
      beginOffChainMarketplaceFeeBatch(100);
      setOffChainMarketplaceFeeRate(V3, BigInt(40000));
      beginOffChainMarketplaceFeeBatch(100);
      data = await getOffChainMarketplaceContractData(ctx, blockAt(100), V3);
    });

    it("should not let the retry see the failed batch's value", () => {
      expect(data.feeRate).toBe(BigInt(25000));
    });
  });

  describe("when a batch starts at or before a block whose writes were already promoted", () => {
    let data: FeeConfig;

    beforeEach(async () => {
      seed(V3, FEE_COLLECTOR_SAFE);
      beginOffChainMarketplaceFeeBatch(100);
      setOffChainMarketplaceFeeRate(V3, BigInt(40000));
      endOffChainMarketplaceFeeBatch(200);
      beginOffChainMarketplaceFeeBatch(201);
      // A rollback: the chain the promoted update came from is gone.
      beginOffChainMarketplaceFeeBatch(150);
      ContractMock.mockImplementation(() => ({
        feeCollector: async () => FEE_COLLECTOR_SAFE,
        feeRate: async () => BigInt(25000),
        royaltiesRate: async () => BigInt(25000),
      }));
      data = await getOffChainMarketplaceContractData(ctx, blockAt(150), V3);
    });

    it("should drop the cache and re-seed from the chain rather than trust orphaned values", () => {
      expect([data.feeRate, ContractMock.mock.calls.length]).toEqual([BigInt(25000), 1]);
    });
  });
});
