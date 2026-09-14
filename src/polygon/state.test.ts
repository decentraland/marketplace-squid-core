import assert from "node:assert";
import { beforeEach, describe, it } from "node:test";

import type { Block, Context } from "./processor";
import {
  getOffChainMarketplaceContractData,
  offChainMarketplaceContractData,
  setOffChainMarketplaceFeeCollector,
  setOffChainMarketplaceFeeRate,
  setOffChainMarketplaceRoyaltiesRate,
} from "./state";

/**
 * Every marketplace version keeps its own fee configuration, and V3 on Polygon collects into a
 * different Safe than V1/V2. These pin that the cache is keyed by the emitting contract, so a sale on
 * one version can never be enriched with another's collector or rates.
 */
const V1 = "0x540fb08edb56aae562864b390542c97f562825ba";
const V3 = "0xe38ef22abe871513555cba89adfe45ab4f548ada";
const COMMITTEE_MULTISIG = "0xb08e3e7cc815213304d884c88ca476ebc50eaab2";
const FEE_COLLECTOR_SAFE = "0x184e4d9a26add0af1eafc145550e890a421f16d7";

// A populated entry is returned without touching the chain, so no client is needed.
const ctx = {} as unknown as Context;
const block = {} as unknown as Block;

describe("getOffChainMarketplaceContractData", () => {
  beforeEach(() => {
    offChainMarketplaceContractData.clear();
  });

  describe("when two marketplaces have been configured through the update setters", () => {
    beforeEach(() => {
      setOffChainMarketplaceFeeCollector(V1, COMMITTEE_MULTISIG);
      setOffChainMarketplaceFeeRate(V1, BigInt(25000));
      setOffChainMarketplaceRoyaltiesRate(V1, BigInt(25000));
      setOffChainMarketplaceFeeCollector(V3, FEE_COLLECTOR_SAFE);
      setOffChainMarketplaceFeeRate(V3, BigInt(25000));
      setOffChainMarketplaceRoyaltiesRate(V3, BigInt(25000));
    });

    it("should resolve each marketplace to its own fee collector", async () => {
      const [v1, v3] = await Promise.all([
        getOffChainMarketplaceContractData(ctx, block, V1),
        getOffChainMarketplaceContractData(ctx, block, V3),
      ]);
      assert.equal(v1.feeCollector, COMMITTEE_MULTISIG);
      assert.equal(v3.feeCollector, FEE_COLLECTOR_SAFE);
    });

    describe("and the emitting address is spelled in a different case", () => {
      it("should resolve the same entry", async () => {
        const data = await getOffChainMarketplaceContractData(
          ctx,
          block,
          V3.toUpperCase().replace("0X", "0x")
        );
        assert.equal(data.feeCollector, FEE_COLLECTOR_SAFE);
      });
    });

    describe("and a fee update arrives from one of them", () => {
      beforeEach(() => {
        setOffChainMarketplaceFeeRate(V3, BigInt(40000));
      });

      it("should change only that marketplace's rate", async () => {
        const [v1, v3] = await Promise.all([
          getOffChainMarketplaceContractData(ctx, block, V1),
          getOffChainMarketplaceContractData(ctx, block, V3),
        ]);
        assert.equal(v3.feeRate, BigInt(40000));
        assert.equal(v1.feeRate, BigInt(25000));
      });
    });
  });
});
