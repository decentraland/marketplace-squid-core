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
 * So the counterparty on the paid side comes from the trade itself, which no beneficiary can redirect —
 * an Order is signed by its seller, and a Bid is accepted (called) by its seller.
 *
 * Historical rows are unaffected: where nobody redirected the payment, the payment beneficiary and the
 * signer/caller are the same address, so a reindex reproduces them identically.
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
      // A bid is signed by the buyer and ACCEPTED by the seller, so the caller is the seller. Same
      // reasoning as the Order branch above, applied to the other direction: sent[0].beneficiary is
      // where the MANA goes, which is not necessarily who sold.
      seller: event._caller,
      buyer: event._trade.received[0].beneficiary,
      price: event._trade.sent[0].value,
      assetType: event._trade.received[0].assetType,
    };
  }
};
