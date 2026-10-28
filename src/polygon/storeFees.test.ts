import * as CollectionStoreABI from "./abi/CollectionStore";
import type { Block, BlockData, Context } from "./processor";
import {
  beginFeeBatch,
  endFeeBatch,
  getStoreContractData,
  resetStoreContractData,
} from "./state";
import { applyFeeUpdate, queueFeeUpdate, QueuedFeeUpdate } from "./utils/feeUpdates";

// The chain read behind a cold-cache seed. Replaced per test so a fake can answer by block height.
jest.mock("./abi/CollectionStore", () => ({
  ...jest.requireActual("./abi/CollectionStore"),
  Contract: jest.fn(),
}));
const { Contract: ContractMock } = jest.requireMock("./abi/CollectionStore") as {
  Contract: jest.Mock;
};

/**
 * Every primary sale records the store's fee owner, so a mint has to read the value in force at its own
 * log position, whatever the batch boundaries and wherever the process started. These pin that a cold
 * seed reads the state BEFORE the mint's block, that updates apply in log order, and that a failed
 * batch's update never reaches its retry.
 */
const STORE = "0x214ffc0f0103735728dc66b61a22e4f163e275ae";
const COMMITTEE_MULTISIG = "0xb08e3e7cc815213304d884c88ca476ebc50eaab2";
const FEE_COLLECTOR_SAFE = "0x184e4d9a26add0af1eafc145550e890a421f16d7";
// The block where the owner changed: state at N is post-block, so it already holds the new owner.
const N = 94_266_515;
const { SetFeeOwner } = CollectionStoreABI.events;

const ctx = {} as unknown as Context;
const blockAt = (height: number) => ({ height } as unknown as Block);
const pad = (hex: string) => "0x" + hex.replace(/^0x/, "").padStart(64, "0");

const ownerChange = (logIndex: number) => {
  const log = {
    address: STORE,
    logIndex,
    transactionHash: "0x" + "ab".repeat(32),
    topics: [SetFeeOwner.topic, pad(COMMITTEE_MULTISIG), pad(FEE_COLLECTOR_SAFE)],
    data: "0x",
  } as unknown as QueuedFeeUpdate["log"];
  const queued = queueFeeUpdate(SetFeeOwner.topic, log, { header: blockAt(N) } as unknown as BlockData)!;
  return () => applyFeeUpdate(queued.topic, queued.log, queued.event);
};

// The chain as it was: the committee multisig up to block N, the safe from N on.
const chain = () =>
  ContractMock.mockImplementation((_ctx: Context, block: Block) => ({
    fee: async () => BigInt(25000),
    feeOwner: async () => (block.height >= N ? FEE_COLLECTOR_SAFE : COMMITTEE_MULTISIG),
  }));

const ownerAt = async (height: number) =>
  (await getStoreContractData(ctx, blockAt(height))).feeOwner?.toLowerCase();

describe("getStoreContractData", () => {
  beforeEach(() => {
    resetStoreContractData();
    ContractMock.mockReset();
    // The seed logs an INFO line; keep the test output to the assertions.
    jest.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("when the process starts cold at a block holding a mint, the owner change and another mint, in that order", () => {
    let owners: (string | undefined)[];

    beforeEach(async () => {
      chain();
      beginFeeBatch(N);
      const before = await ownerAt(N);
      ownerChange(9)();
      const after = await ownerAt(N);
      endFeeBatch(N);
      owners = [before, after];
    });

    it("should give the first mint the owner before the change and the second the new one", () => {
      expect(owners).toEqual([COMMITTEE_MULTISIG, FEE_COLLECTOR_SAFE]);
    });

    it("should seed from the block before the mint's", () => {
      expect(ContractMock.mock.calls[0][1].height).toBe(N - 1);
    });
  });

  describe("when the same mints and change are split across two batches", () => {
    let owners: (string | undefined)[];

    beforeEach(async () => {
      chain();
      beginFeeBatch(N - 10);
      const before = await ownerAt(N - 10);
      endFeeBatch(N - 1);
      beginFeeBatch(N);
      ownerChange(9)();
      const after = await ownerAt(N + 10);
      endFeeBatch(N + 10);
      owners = [before, after];
    });

    it("should give each mint the same owner as in one batch", () => {
      expect(owners).toEqual([COMMITTEE_MULTISIG, FEE_COLLECTOR_SAFE]);
    });
  });

  describe("when a batch applies the owner change and fails before committing", () => {
    let retry: string | undefined;

    beforeEach(async () => {
      chain();
      beginFeeBatch(N);
      await ownerAt(N);
      ownerChange(9)();
      // The batch throws: the processor hands the same range back without ending it.
      beginFeeBatch(N);
      retry = await ownerAt(N);
    });

    it("should give the retry's first mint the owner before the change", () => {
      expect(retry).toBe(COMMITTEE_MULTISIG);
    });
  });

  describe("when the mint is in the block where the store was deployed or before", () => {
    let data: Awaited<ReturnType<typeof getStoreContractData>>;

    beforeEach(async () => {
      chain();
      data = await getStoreContractData(ctx, blockAt(1));
    });

    it("should not read the chain, since there is no store to read", () => {
      expect(ContractMock).not.toHaveBeenCalled();
    });

    it("should leave the configuration empty, since the store sold nothing yet", () => {
      expect([data.fee, data.feeOwner]).toEqual([undefined, undefined]);
    });
  });

  describe("when the chain read fails", () => {
    let seed: Promise<unknown>;

    beforeEach(() => {
      ContractMock.mockImplementation(() => ({
        fee: async () => BigInt(25000),
        feeOwner: async () => {
          throw new Error("RPC unavailable");
        },
      }));
      seed = getStoreContractData(ctx, blockAt(N));
    });

    // Carrying on would skip the sale for good: the next batch never replays it.
    it("should reject so the batch fails and is retried", async () => {
      await expect(seed).rejects.toThrow("RPC unavailable");
    });

    it("should not keep the fee it did read", async () => {
      await seed.catch(() => undefined);
      ContractMock.mockReset();
      chain();
      await getStoreContractData(ctx, blockAt(N));
      expect(ContractMock).toHaveBeenCalledTimes(1);
    });
  });
});
