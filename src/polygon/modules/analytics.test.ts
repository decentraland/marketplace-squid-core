import { createAccount } from "../../common/modules/account";
import { Account, Item, NFT, Network, SaleType } from "../../model";
import type { Block, Context } from "../processor";
import type { PolygonInMemoryState, PolygonStoredData } from "../types";
import { loadAccount, trackSale } from "./analytics";

const FEES_COLLECTOR = "0x0000000000000000000000000000000000000fee";

describe("loadAccount", () => {
  let accounts: Map<string, Account>;
  let get: jest.Mock;
  let ctx: Context;

  beforeEach(() => {
    accounts = new Map();
    get = jest.fn();
    ctx = { store: { get } } as unknown as Context;
  });

  describe("when the batch did not read an account the store holds", () => {
    let stored: Account;

    beforeEach(() => {
      stored = createAccount(FEES_COLLECTOR, Network.POLYGON);
      stored.earned = BigInt(500);
      get.mockResolvedValueOnce(stored);
    });

    it("should add to the stored account instead of a new one", async () => {
      const account = await loadAccount(ctx, accounts, FEES_COLLECTOR);
      account.earned = account.earned + BigInt(20);

      expect(account).toBe(stored);
      expect(accounts.get(`${FEES_COLLECTOR}-POLYGON`)?.earned).toBe(
        BigInt(520)
      );
    });

    it("should read it once per batch", async () => {
      await loadAccount(ctx, accounts, FEES_COLLECTOR);
      await loadAccount(ctx, accounts, FEES_COLLECTOR);

      expect(get).toHaveBeenCalledTimes(1);
    });
  });

  describe("when the store holds no such account", () => {
    beforeEach(() => {
      get.mockResolvedValueOnce(undefined);
    });

    it("should create it", async () => {
      const account = await loadAccount(ctx, accounts, FEES_COLLECTOR);

      expect(account.id).toBe(`${FEES_COLLECTOR}-POLYGON`);
      expect(account.earned).toBe(BigInt(0));
    });
  });
});

describe("trackSale", () => {
  const CREATOR = "0x0000000000000000000000000000000000000c0c";
  const BUYER = "0x0000000000000000000000000000000000000b0b";
  const COLLECTION = "0x0000000000000000000000000000000000000c01";

  describe("when an item is minted and its creator was not read up front", () => {
    let stored: Account;
    let accounts: Map<string, Account>;

    beforeEach(async () => {
      stored = createAccount(CREATOR, Network.POLYGON);
      stored.earned = BigInt(500);
      stored.primarySales = 3;
      const get = jest.fn(async (_: unknown, id: string) =>
        id === stored.id ? stored : undefined
      );
      const ctx = { store: { get } } as unknown as Context;
      const item = new Item({
        id: `${COLLECTION}-0`,
        creator: CREATOR,
        beneficiary: CREATOR,
        rarity: "common",
        blockchainId: BigInt(0),
        collection: { id: COLLECTION } as Item["collection"],
        sales: 0,
        volume: BigInt(0),
        uniqueCollectors: [],
        uniqueCollectorsTotal: 0,
      });
      const nft = new NFT({
        id: `${COLLECTION}-1`,
        contractAddress: COLLECTION,
        tokenId: BigInt(1),
        category: "wearable" as NFT["category"],
        sales: 0,
        volume: BigInt(0),
      });
      accounts = new Map();
      const storedData = {
        counts: new Map(),
        nfts: new Map([[nft.id, nft]]),
        items: new Map([[item.id, item]]),
        accounts,
        analytics: new Map(),
        itemDayDatas: new Map(),
        accountsDayDatas: new Map(),
      } as unknown as PolygonStoredData;
      const inMemoryData = {
        sales: new Map(),
      } as unknown as PolygonInMemoryState;

      await trackSale(
        ctx,
        { height: 1, timestamp: 1_700_000_000_000 } as unknown as Block,
        storedData,
        inMemoryData,
        SaleType.mint,
        BUYER,
        CREATOR,
        CREATOR,
        item.id,
        nft.id,
        BigInt(100),
        BigInt(0),
        "0x0000000000000000000000000000000000000fee",
        BigInt(0),
        BigInt(1_700_000_000),
        "0xtx"
      );
    });

    it("should add the sale to the creator's stored account", () => {
      const creator = accounts.get(`${CREATOR}-POLYGON`);

      expect(creator).toBe(stored);
      expect(creator?.earned).toBe(BigInt(600));
      expect(creator?.primarySales).toBe(4);
    });
  });
});
