import assert from "node:assert";
import { describe, it } from "node:test";

// getAddresses picks the address book from the chain id, so this has to be set before the module under
// test resolves it.
process.env.POLYGON_CHAIN_ID = "80002";

import { Network } from "@dcl/schemas";

import { TradedEventArgs } from "../../abi/DecentralandMarketplaceEthereum";
import { getTradeEventData, TradeAssetType } from "./marketplaceV3";
import { MANA } from "../../polygon/addresses/amoy";

/**
 * Who a sale is attributed to.
 *
 * The payment leg's `beneficiary` means "who gets paid", and for years that was also "who sold" —
 * nobody redirected a payment. The Shop does: it signs listings that pay the platform treasury, which
 * credits the seller off-chain. Reading the seller off that beneficiary silently reassigned every such
 * sale to the treasury, which is what these tests pin against.
 */

const SELLER = "0x2a4f9a28ba76413ef182351d864cc2916e462c3b";
const BUYER = "0x747c6f502272129bf1ba872a1903045b837ee86c";
const TREASURY = "0x3eedeceafa4797d36819c1d9f8e3b0071285ad69";
const COLLECTION = "0x03b1940d80394614a5ba60abbf73fa749068bdad";
/** The CreditsManager on Amoy — the msg.sender for every credits-funded purchase. */
const CONTRACT = "0x8052a560e6e6ac86eeb7e711a4497f639b322fb3";

type Asset = {
  assetType: number;
  contractAddress: string;
  value: bigint;
  beneficiary: string;
  extra: string;
};

const asset = (over: Partial<Asset> = {}): Asset => ({
  assetType: TradeAssetType.ERC721,
  contractAddress: COLLECTION,
  value: 1n,
  beneficiary: BUYER,
  extra: "0x",
  ...over,
});

const manaAsset = (beneficiary: string, assetType = TradeAssetType.ERC20) =>
  asset({ assetType, contractAddress: MANA, value: 4079992178284085849n, beneficiary });

/** A Traded event, shaped like the ABI decoder produces it. Only the fields the mapping reads. */
const tradedEvent = (opts: {
  signer: string;
  caller: string;
  sent: Asset[];
  received: Asset[];
}) =>
  ({
    _caller: opts.caller,
    _signature: "0x" + "0".repeat(64),
    _trade: { signer: opts.signer, sent: opts.sent, received: opts.received },
  } as unknown as TradedEventArgs);

describe("getTradeEventData — sale attribution", () => {
  describe("an order (a listing, signed by its seller)", () => {
    it("should attribute the sale to the signer, not to whoever was paid", () => {
      // THE regression: the Shop routes the MANA to the treasury and credits the seller off-chain. The
      // seller still sold it — reading `received[0].beneficiary` here made their sales disappear from
      // /v1/sales?seller= and credited the treasury in `updateCreatorsSupportedSet`.
      const event = tradedEvent({
        signer: SELLER,
        caller: BUYER,
        sent: [asset({ beneficiary: BUYER })],
        received: [manaAsset(TREASURY, TradeAssetType.USD_PEGGED_MANA)],
      });

      const data = getTradeEventData(event, Network.MATIC);

      assert.strictEqual(data.seller, SELLER);
      assert.strictEqual(data.buyer, BUYER);
    });

    it("should be immune to a contract standing in for msg.sender", () => {
      // The exact shape of the sale that exposed all of this on dev: paid with credits, so the
      // CreditsManager forwarded `accept()` and msg.sender was neither party. The signer is recovered
      // from the signature, so mediation cannot touch it — which is why the order branch reads it and
      // the bid branch (where no signed field names the seller) cannot.
      const event = tradedEvent({
        signer: SELLER,
        caller: CONTRACT,
        sent: [asset({ beneficiary: BUYER })],
        received: [manaAsset(TREASURY, TradeAssetType.USD_PEGGED_MANA)],
      });

      const data = getTradeEventData(event, Network.MATIC);

      assert.strictEqual(data.seller, SELLER);
      assert.strictEqual(data.buyer, BUYER);
    });

    it("should be unchanged when the seller is paid directly", () => {
      // Every historical row. Signer and payment beneficiary are the same address, so a reindex under
      // this change has to reproduce them identically — that is what makes the fix safe to ship.
      const event = tradedEvent({
        signer: SELLER,
        caller: BUYER,
        sent: [asset({ beneficiary: BUYER })],
        received: [manaAsset(SELLER)],
      });

      const data = getTradeEventData(event, Network.MATIC);

      assert.strictEqual(data.seller, SELLER);
      assert.strictEqual(data.buyer, BUYER);
    });

    it("should still read the asset side for the buyer and the price", () => {
      const event = tradedEvent({
        signer: SELLER,
        caller: BUYER,
        sent: [asset({ beneficiary: BUYER, value: 42n })],
        received: [manaAsset(TREASURY, TradeAssetType.USD_PEGGED_MANA)],
      });

      const data = getTradeEventData(event, Network.MATIC);

      assert.strictEqual(data.collectionAddress, COLLECTION);
      assert.strictEqual(data.tokenId, 42n);
      assert.strictEqual(data.price, 4079992178284085849n);
    });
  });

  describe("a bid (signed by its buyer — the seller is not in the signed trade)", () => {
    it("should read the seller from the payment beneficiary, not from msg.sender", () => {
      // THE case `_caller` got wrong. A CreditsManager or a meta-transaction relay sits between the
      // seller and the marketplace, so msg.sender is a CONTRACT — attributing the sale to it. Measured
      // on dev, that already happens for 7 of 42 order sales and 144 of 256 mints; bids are only spared
      // because nothing mediates them yet.
      const event = tradedEvent({
        signer: BUYER,
        caller: CONTRACT,
        sent: [manaAsset(SELLER)],
        received: [asset({ beneficiary: BUYER })],
      });

      const data = getTradeEventData(event, Network.MATIC);

      assert.strictEqual(data.seller, SELLER);
      assert.strictEqual(data.buyer, BUYER);
    });

    it("should read the seller from the payment beneficiary when they called directly", () => {
      // Every bid on dev today (22/22): caller and payment beneficiary are the same address, so this
      // holds either way. It is here to pin that the reindex is a no-op for existing bid rows.
      const event = tradedEvent({
        signer: BUYER,
        caller: SELLER,
        sent: [manaAsset(SELLER)],
        received: [asset({ beneficiary: BUYER })],
      });

      const data = getTradeEventData(event, Network.MATIC);

      assert.strictEqual(data.seller, SELLER);
      assert.strictEqual(data.buyer, BUYER);
    });
  });
});
