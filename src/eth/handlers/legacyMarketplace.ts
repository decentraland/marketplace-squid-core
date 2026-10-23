import { Network } from "@dcl/schemas";
import {
  AuctionCancelledEventArgs,
  AuctionCreatedEventArgs,
  AuctionSuccessfulEventArgs,
} from "../../abi/Marketplace";
import { getNFTId } from "../../common/utils";
import { getAddresses } from "../../common/utils/addresses";
import { normalizeTimestamp } from "../../common/utils/utils";
import {
  Category,
  NFT,
  Order,
  OrderStatus,
  Network as ModelNetwork,
} from "../../model";
import { BlockData } from "../processor";

/**
 * The LAND marketplace of 2018, before the Marketplace contract: it sold parcels only, and its
 * auctions are kept as orders so their sellers can still find and cancel the open ones. They are
 * history, not listings: they never become an NFT's active order and record no sale or count, so
 * nothing else the squid serves changes.
 */

export type LegacyMarketplaceEvents =
  | AuctionCreatedEventArgs
  | AuctionSuccessfulEventArgs
  | AuctionCancelledEventArgs;

const landNFTId = (assetId: bigint) =>
  getNFTId(
    getAddresses(Network.ETHEREUM).LANDRegistry,
    assetId.toString(),
    Category.parcel
  );

export function handleAuctionCreated(
  event: AuctionCreatedEventArgs,
  block: BlockData,
  contractAddress: string,
  txHash: string,
  orders: Map<string, Order>,
  nfts: Map<string, NFT>
): void {
  const { id, assetId, seller, priceInWei, expiresAt } = event;
  const nftId = landNFTId(assetId);
  const nft = nfts.get(nftId);
  if (!nft) {
    console.log(`ERROR: NFT not found for legacy auction created ${nftId}`);
    return;
  }
  const timestamp = BigInt(block.header.timestamp / 1000);

  // The contract keeps one auction per parcel: a new one replaces the open one.
  for (const order of orders.values()) {
    if (
      order.nft?.id === nftId &&
      order.marketplaceAddress === contractAddress &&
      order.status === OrderStatus.open
    ) {
      order.status = OrderStatus.cancelled;
      order.updatedAt = timestamp;
    }
  }

  const order = new Order({ id });
  order.network = ModelNetwork.ETHEREUM;
  order.marketplaceAddress = contractAddress;
  order.status = OrderStatus.open;
  order.category = Category.parcel;
  order.nft = nft;
  order.item = null;
  order.nftAddress = getAddresses(Network.ETHEREUM).LANDRegistry;
  order.tokenId = assetId;
  order.txHash = txHash;
  order.owner = seller;
  order.price = priceInWei;
  order.expiresAt = expiresAt;
  order.expiresAtNormalized = normalizeTimestamp(expiresAt);
  order.blockNumber = BigInt(block.header.height);
  order.createdAt = timestamp;
  order.updatedAt = timestamp;
  orders.set(id, order);
}

export function handleAuctionSuccessful(
  event: AuctionSuccessfulEventArgs,
  block: BlockData,
  orders: Map<string, Order>
): void {
  const order = orders.get(event.id);
  if (!order) {
    console.log(
      `ERROR: Order not found for legacy auction successful ${event.id}`
    );
    return;
  }
  order.status = OrderStatus.sold;
  order.buyer = event.winner;
  order.price = event.totalPrice;
  order.blockNumber = BigInt(block.header.height);
  order.updatedAt = BigInt(block.header.timestamp / 1000);
}

export function handleAuctionCancelled(
  event: AuctionCancelledEventArgs,
  block: BlockData,
  orders: Map<string, Order>
): void {
  const order = orders.get(event.id);
  if (!order) {
    console.log(
      `ERROR: Order not found for legacy auction cancelled ${event.id}`
    );
    return;
  }
  order.status = OrderStatus.cancelled;
  order.blockNumber = BigInt(block.header.height);
  order.updatedAt = BigInt(block.header.timestamp / 1000);
}
