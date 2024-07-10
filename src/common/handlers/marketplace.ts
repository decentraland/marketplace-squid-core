import { BlockData } from "@subsquid/evm-processor";
import { Network } from "@dcl/schemas";
import {
  OrderCancelledEventArgs,
  OrderCreatedEventArgs,
  OrderSuccessfulEventArgs,
} from "../../abi/Marketplace";
import { getCategory } from "../../common/utils/category";
import {
  cancelActiveOrder,
  getNFTId,
  updateNFTOrderProperties,
} from "../../common/utils";
import {
  Account,
  AnalyticsDayData,
  Category,
  Count,
  NFT,
  Order,
  OrderStatus,
  Sale,
  Network as NetworkModel,
} from "../../model";
import { buildCountFromOrder } from "../modules/count";
import { ORDER_SALE_TYPE } from "../modules/analytics";

// export type MarkteplaceEvents =
//   | OrderCreatedEventArgs
//   | OrderSuccessfulEventArgs
//   | OrderCancelledEventArgs;

// export function handleOrderCreated(
//   network: Network,
//   event: OrderCreatedEventArgs,
//   block: BlockData,
//   contractAddress: string,
//   txHash: string,
//   orders: Map<string, Order>,
//   nfts: Map<string, NFT>,
//   counts: Map<string, Count>
// ): void {
//   const { assetId, nftAddress, id, seller, priceInWei, expiresAt } = event;

//   const isEthereum = network === Network.ETHEREUM;

//   const category = isEthereum
//     ? getCategory(Network.ETHEREUM, nftAddress)
//     : undefined;
//   const nftId = getNFTId(nftAddress, assetId.toString(), category);
//   const nft = nfts.get(nftId);
//   if (nft) {
//     const orderId = id;

//     const order = new Order({ id: orderId });
//     order.marketplaceAddress = contractAddress;
//     order.status = OrderStatus.open;
//     order.category = category ? (category as Category) : Category.wearable;
//     order.nft = nft;
//     order.network = isEthereum ? NetworkModel.ethereum : NetworkModel.polygon;
//     if (!isEthereum) {
//       order.item = nft.item;
//     }
//     order.nftAddress = nftAddress;
//     order.tokenId = assetId;
//     order.txHash = txHash;
//     order.owner = seller;
//     order.price = priceInWei;
//     order.expiresAt = expiresAt;
//     order.blockNumber = BigInt(block.header.height); // @TODO review this type
//     const timestamp = BigInt(block.header.timestamp / 1000);
//     order.createdAt = timestamp;
//     order.updatedAt = timestamp;

//     if (nft.activeOrder) {
//       const oldOrder = orders.get(nft.activeOrder.id);

//       if (oldOrder) {
//         cancelActiveOrder(oldOrder, timestamp);
//       }
//     }
//     nft.updatedAt = timestamp;
//     updateNFTOrderProperties(nft, order);

//     buildCountFromOrder(order, counts);
//     orders.set(orderId, order);
//   } else {
//     console.log(`ERROR: NFT not found for order created ${nftId}`);
//   }
// }

// export function handleOrderSuccessful(
//   network: Network,
//   event: OrderSuccessfulEventArgs,
//   block: BlockData,
//   txHash: string,
//   ownerCutPerMillionValue: bigint,
//   orders: Map<string, Order>,
//   nfts: Map<string, NFT>,
//   accounts: Map<string, Account>,
//   analytics: Map<string, AnalyticsDayData>,
//   counts: Map<string, Count>,
//   sales: Map<string, Sale>
// ): void {
//   const { assetId, buyer, id, nftAddress, seller, totalPrice } = event;

//   const isEthereum = network === Network.ETHEREUM;
//   const category = isEthereum
//     ? getCategory(Network.ETHEREUM, nftAddress)
//     : undefined;

//   const nftId = getNFTId(nftAddress, assetId.toString(), category);
//   const orderId = id;
//   const order = orders.get(orderId);
//   if (!order) {
//     console.log(`ERROR: Order not found for order successful ${orderId}`);
//     return;
//   }

//   order.category = category as Category;
//   order.status = OrderStatus.sold;
//   order.buyer = buyer;
//   order.price = totalPrice;
//   order.blockNumber = BigInt(block.header.height);
//   const timestamp = BigInt(block.header.timestamp / 1000);
//   order.updatedAt = timestamp;

//   const nft = nfts.get(nftId);
//   if (!nft) {
//     console.log(`ERROR: NFT not found for order successful ${nftId}`);
//     return;
//   }

//   const buyerAccount = accounts.get(buyer);
//   if (buyerAccount) {
//     nft.owner = buyerAccount;
//   } else {
//     console.log("ERROR: Buyer account not found for order successful");
//   }

//   nft.updatedAt = timestamp;
//   updateNFTOrderProperties(nft!, order!);

//   trackSale(
//     network,
//     ORDER_SALE_TYPE,
//     buyer,
//     seller,
//     nft.id,
//     order.price,
//     ownerCutPerMillionValue,
//     BigInt(block.header.timestamp / 1000), // @TODO fix this, has the have the event hash not the block
//     txHash,
//     nfts,
//     sales,
//     accounts,
//     analytics,
//     counts
//   );
// }

// export function handleOrderCancelled(
//   network: Network,
//   event: OrderCancelledEventArgs,
//   block: BlockData,
//   nfts: Map<string, NFT>,
//   orders: Map<string, Order>
// ): void {
//   const { assetId, id, nftAddress, seller } = event;
//   const isEthereum = network === Network.ETHEREUM;
//   const category = isEthereum
//     ? getCategory(Network.ETHEREUM, nftAddress)
//     : undefined;
//   const nftId = getNFTId(nftAddress, assetId.toString(), category);

//   const nft = nfts.get(nftId);
//   const order = orders.get(id);

//   if (nft && order) {
//     order.category = category as Category;
//     order.status = OrderStatus.cancelled;
//     order.blockNumber = BigInt(block.header.height);
//     const timestamp = BigInt(block.header.timestamp / 1000);
//     order.updatedAt = timestamp;

//     nft.updatedAt = timestamp;
//     updateNFTOrderProperties(nft, order);
//   } else {
//     console.log(`ERROR: NFT not found for order cancelled ${nftId}`);
//   }
// }
