import { createAccount } from "../../common/modules/account";
import { Account, Network } from "../../model";
import type { Context } from "../processor";
import { loadAccount } from "./analytics";

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
