import { TradedEventArgs } from "../../abi/DecentralandMarketplaceEthereum";
import { Network } from "../../types";
import { getAddresses } from "./addresses";

export enum TradeType {
  Order = "Order",
  Bid = "Bid",
}

export enum TradeAssetType {
  ERC20 = 1,
  USD_PEGGED_MANA = 2,
  ERC721 = 3,
  ITEM = 4,
}

// Payment asset types that settle in MANA: plain ERC20 MANA and the USD-pegged MANA the credits
// checkout (the Shop) uses. Both are priced in the MANA contract, so a trade whose payment leg is
// either one is a MANA sale/bid — see getTradeEventType.
const MANA_PAYMENT_ASSET_TYPES = [
  TradeAssetType.ERC20,
  TradeAssetType.USD_PEGGED_MANA,
];

export const getTradeEventType = (
  event: TradedEventArgs,
  network: Network
): TradeType | undefined => {
  const addresses = getAddresses(network);

  // We're only supporting the case of one trade for the moment. We could have multiple trades in the future.
  // A MANA payment leg is either plain ERC20 MANA or USD-pegged MANA (the credits/Shop checkout) — both
  // must be recognized, otherwise a credits sale is misclassified and its collection/tokenId are read off
  // the wrong asset, so the mint never gets indexed.
  const isReceivingMana = MANA_PAYMENT_ASSET_TYPES.includes(
    Number(event._trade.received[0].assetType)
  );
  const isSendingMana = MANA_PAYMENT_ASSET_TYPES.includes(
    Number(event._trade.sent[0].assetType)
  );
  const contractAddressReceived = event._trade.received[0].contractAddress;
  const contractAddressSent = event._trade.sent[0].contractAddress;

  // if received is MANA, then it's an order. We could also have other ERC20 sent, but for the moment we are only checking for MANA
  if (
    isReceivingMana &&
    [addresses.MANA, addresses.TRANSAK_TOKEN].includes(contractAddressReceived) // support Transak token to track sales in dev
  ) {
    return TradeType.Order;
  } else if (
    isSendingMana &&
    [addresses.MANA, addresses.TRANSAK_TOKEN].includes(contractAddressSent)
  ) {
    return TradeType.Bid;
  }
};

/**
 * Who sold and who bought, from a Traded event.
 *
 * `sent` and `received` are written from the SIGNER's perspective, and a `beneficiary` answers "who
 * receives this asset". For the ASSET leg that is the same question as "who bought it", so the buyer is
 * still read from there. For the PAYMENT leg it is not: it answers "who gets paid", which coincided with
 * "who sold" only for as long as every seller was paid directly.
 *
 * They stopped coinciding. The Shop signs listings whose payment beneficiary is the platform treasury,
 * which credits the seller off-chain instead. Reading the seller off that beneficiary attributed every
 * such sale to the treasury: the seller's own sales vanished from `/v1/sales?seller=`, and
 * `updateCreatorsSupportedSet` recorded the treasury rather than the creator the buyer actually supported.
 *
 * An order's seller therefore comes from `_trade.signer`, which is recovered from the EIP-712 signature
 * and cannot be redirected by anything in the trade.
 *
 * A bid has no such field — a bid is signed by its BUYER, so the seller appears nowhere in the signed
 * trade — and `msg.sender` is not a substitute, because a contract is routinely in between (see the Bid
 * branch). It keeps reading the payment beneficiary, which is correct until something redirects a bid's
 * payment; nothing does.
 *
 * Historical rows are unaffected: with no redirection the signer and the payment beneficiary are the
 * same address, so a reindex reproduces them identically.
 */
export const getTradeEventData = (event: TradedEventArgs, network: Network) => {
  const tradeType = getTradeEventType(event, network);
  if (tradeType === TradeType.Order) {
    return {
      collectionAddress: event._trade.sent[0].contractAddress,
      tokenId:
        Number(event._trade.sent[0].assetType) === TradeAssetType.ERC721
          ? event._trade.sent[0].value
          : undefined,
      itemId:
        Number(event._trade.sent[0].assetType) === TradeAssetType.ITEM
          ? event._trade.sent[0].value
          : undefined,
      // The listing's signer. NOT received[0].beneficiary — that is whoever the payment was directed to,
      // which the Shop points at the platform treasury.
      seller: event._trade.signer,
      buyer: event._trade.sent[0].beneficiary,
      price: event._trade.received[0].value,
      assetType: event._trade.sent[0].assetType,
    };
  } else {
    return {
      collectionAddress: event._trade.received[0].contractAddress,
      tokenId:
        Number(event._trade.received[0].assetType) === TradeAssetType.ERC721
          ? event._trade.received[0].value
          : undefined,
      itemId:
        Number(event._trade.received[0].assetType) === TradeAssetType.ITEM
          ? event._trade.received[0].value
          : undefined,
      // Where the MANA goes. `_caller` looks like the better answer — a bid IS accepted by its seller —
      // but only when the seller calls the marketplace directly. `msg.sender` is a CONTRACT whenever the
      // acceptance is mediated: the CreditsManager forwards `accept()` for credits purchases, and the
      // dapps send `executeMetaTransaction` through a relay. Measured on dev: of 42 order sales the
      // caller is the buyer 35 times and some other address 7 times; of 256 mints it is neither party
      // 144 times. Bids are simply the case that has not been mediated yet (22/22 called by the seller).
      //
      // So the two candidates fail in opposite situations, and this one's does not exist yet: the
      // beneficiary is wrong only if a bid's payment is REDIRECTED, which nothing does today, whereas
      // `_caller` is wrong as soon as anything mediates the call — already routine everywhere else.
      //
      // Unlike an order, a bid's seller is not in the signed trade at all (the BUYER signs a bid), so no
      // on-chain field identifies them once a contract sits in between. If the Shop ever routes bid
      // proceeds to the treasury, resolve the seller from the off-chain trade record — which knows both
      // counterparties — rather than from another guess on this event.
      seller: event._trade.sent[0].beneficiary,
      buyer: event._trade.received[0].beneficiary,
      price: event._trade.sent[0].value,
      assetType: event._trade.received[0].assetType,
    };
  }
};
