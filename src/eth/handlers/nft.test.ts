import { Collection, Item, NFT } from "../../model";
import { handleTransferWearableV1 } from "./nft";

const COLLECTION = "0xd35147be6401dcb20811f2104c33de8e97ed6818";
const FROM = "0x0000000000000000000000000000000000000a11";
const TO = "0x0000000000000000000000000000000000000b0b";
const TOKEN_ID = BigInt(7);
const NFT_ID = `${COLLECTION}-7`;
const ITEM_ID = `${COLLECTION}-funny_skull_mask`;

const block = { height: 9_000_000, timestamp: 1_600_000_000_000 } as never;

describe("when a V1 wearable is transferred", () => {
  let collections: Map<string, Collection>;
  let nfts: Map<string, NFT>;
  let collection: Collection;

  const transfer = () =>
    handleTransferWearableV1(
      block,
      COLLECTION,
      { from: FROM, to: TO, tokenId: TOKEN_ID } as never,
      collections,
      new Map([[ITEM_ID, new Item({ id: ITEM_ID, collection, urn: "urn" })]]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      nfts,
      new Map([[`${COLLECTION}-${TOKEN_ID}`, "dcl://halloween_2019/funny_skull_mask/7"]])
    );

  beforeEach(() => {
    collection = new Collection({ id: COLLECTION });
    nfts = new Map([[NFT_ID, new NFT({ id: NFT_ID, collection })]]);
  });

  describe("and the batch did not load its collection, because it added no wearable to it", () => {
    beforeEach(() => {
      collections = new Map();
      transfer();
    });

    it("should keep the NFT linked to the item's collection", () => {
      expect(nfts.get(NFT_ID)?.collection).toBe(collection);
    });
  });

  describe("and the batch loaded its collection", () => {
    let loaded: Collection;

    beforeEach(() => {
      loaded = new Collection({ id: COLLECTION });
      collections = new Map([[COLLECTION, loaded]]);
      transfer();
    });

    it("should link the NFT to the loaded collection", () => {
      expect(nfts.get(NFT_ID)?.collection).toBe(loaded);
    });
  });
});
