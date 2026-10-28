import { Network } from "@dcl/schemas";
import { createAccount } from "../../common/modules/account";
import { getNFTId } from "../../common/utils";
import { getAddresses } from "../../common/utils/addresses";
import { Account, Category, ENS, NFT } from "../../model";
import { handleNameRegistered } from "./ens";

// A router that registers the name and hands it over in the same transaction.
const ROUTER = "0x6843291bd86857d97f0d269e698939fb10d60772";
const USER = "0x0000000000000000000000000000000000000b0b";
const LABEL_HASH = "0x" + "11".repeat(32);
// The network the tests run on decides the address, as it does for the handler.
const ID = getNFTId(
  getAddresses(Network.ETHEREUM).DCLRegistrar,
  BigInt(LABEL_HASH).toString(),
  Category.ens
);

const registered = {
  _caller: ROUTER,
  _beneficiary: USER,
  _labelHash: LABEL_HASH,
  _subdomain: "name",
  _createdDate: BigInt(1700000000),
};

describe("when a name is registered", () => {
  let ensMap: Map<string, ENS>;
  let nfts: Map<string, NFT>;
  let accounts: Map<string, Account>;

  beforeEach(() => {
    ensMap = new Map();
    nfts = new Map();
    accounts = new Map();
  });

  describe("and the batch already moved its token to the user", () => {
    beforeEach(() => {
      nfts.set(ID, new NFT({ id: ID, owner: createAccount(USER) }));
      handleNameRegistered(registered, ensMap, nfts, accounts);
    });

    it("should give the name to the token's owner, not to the caller", () => {
      expect(ensMap.get(ID)?.owner.id).toEqual(`${USER}-ETHEREUM`);
    });

    it("should still record who called", () => {
      expect(ensMap.get(ID)?.caller).toEqual(ROUTER);
    });
  });

  describe("and the batch holds no transfer of its token", () => {
    beforeEach(() => {
      handleNameRegistered(registered, ensMap, nfts, accounts);
    });

    it("should give the name to the caller", () => {
      expect(ensMap.get(ID)?.owner.id).toEqual(`${ROUTER}-ETHEREUM`);
    });
  });
});
