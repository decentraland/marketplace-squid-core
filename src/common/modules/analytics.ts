import { BlockData } from "@subsquid/evm-processor";
import { createOrLoadAccount } from "./account";
import { ONE_MILLION } from "../utils/utils";
import {
  Account,
  AnalyticsDayData,
  Count,
  NFT,
  Network as ModelNetwork,
  Sale,
  SaleType,
} from "../../model";
import { buildCountFromSale } from "./count";
import { Network } from "@dcl/schemas";

export let BID_SALE_TYPE = "bid";
export let ORDER_SALE_TYPE = "order";

// export function trackSale(
//   network: Network,
//   type: string,
//   buyer: string,
//   seller: string,
//   nftId: string,
//   price: bigint,
//   feesCollectorCut: bigint,
//   timestamp: bigint,
//   txHash: string,
//   nfts: Map<string, NFT>,
//   sales: Map<string, Sale>,
//   accounts: Map<string, Account>,
//   analytics: Map<string, AnalyticsDayData>,
//   counts: Map<string, Count>
// ): void {
//   // ignore zero price sales
//   if (price === BigInt(0)) {
//     console.log("ignoring zero price sale");
//     return;
//   }

//   // count sale
//   const count = buildCountFromSale(price, feesCollectorCut, counts);
//   counts.set(count.id, count);

//   // load entities
//   const nft = nfts.get(nftId);

//   // save sale
//   const saleId = count.salesTotal.toString();
//   const sale = new Sale({ id: saleId });
//   const isEthereum = network === Network.ETHEREUM;
//   sale.network = isEthereum ? ModelNetwork.ethereum : ModelNetwork.polygon;
//   sale.type = type as SaleType;
//   sale.buyer = buyer;
//   sale.seller = seller;
//   sale.price = price;
//   if (nft) {
//     sale.nft = nft;
//     sale.searchTokenId = nft.tokenId;
//     sale.searchContractAddress = nft.contractAddress;
//     sale.searchCategory = nft.category;
//   } else {
//     console.log("ERROR: NFT not found for sale", nftId);
//   }
//   sale.timestamp = timestamp;
//   sale.txHash = txHash;
//   sales.set(saleId, sale);

//   // update buyer account
//   const buyerAccount = createOrLoadAccount(accounts, buyer);
//   if (buyerAccount) {
//     buyerAccount.purchases += 1;
//     buyerAccount.spent = buyerAccount.spent + price;
//     accounts.set(buyer, buyerAccount);
//   }

//   // update seller account
//   const sellerAccount = createOrLoadAccount(accounts, seller);
//   if (sellerAccount) {
//     sellerAccount.sales += 1;
//     sellerAccount.earned = sellerAccount.earned + price;
//     accounts.set(seller, sellerAccount);
//   }

//   // update nft
//   if (nft) {
//     nft.soldAt = timestamp;
//     nft.sales += 1;
//     nft.volume = nft.volume + price;
//     nft.updatedAt = timestamp;
//     nfts.set(nftId, nft);
//   }

//   const analyticsDayData = updateAnalyticsDayData(
//     sale,
//     feesCollectorCut,
//     analytics
//   );
//   analytics.set(analyticsDayData.id, analyticsDayData);
// }

export function getOrCreateAnalyticsDayData(
  blockTimestamp: bigint,
  analytics: Map<string, AnalyticsDayData>,
  network: ModelNetwork = ModelNetwork.ethereum
): AnalyticsDayData {
  const timestamp = blockTimestamp;
  const dayID = timestamp / BigInt(86400); // unix timestamp for start of day / 86400 giving a unique day index
  const dayStartTimestamp = dayID * BigInt(86400);
  let analyticsDayData = analytics.get(dayID.toString());
  if (!analyticsDayData) {
    analyticsDayData = new AnalyticsDayData({
      id: `${dayID.toString()}-${network}`,
    });
    analyticsDayData.date = +dayStartTimestamp.toString(); // unix timestamp for start of day
    analyticsDayData.sales = 0;
    analyticsDayData.volume = BigInt(0);
    analyticsDayData.creatorsEarnings = BigInt(0); // won't be used at all, the bids and transfer from here have no fees for creators
    analyticsDayData.daoEarnings = BigInt(0);
    analyticsDayData.network = network;
  }
  return analyticsDayData;
}

export function updateAnalyticsDayData(
  sale: Sale,
  feesCollectorCut: bigint,
  analytics: Map<string, AnalyticsDayData>
): AnalyticsDayData {
  const analyticsDayData = getOrCreateAnalyticsDayData(
    sale.timestamp,
    analytics
  );
  analyticsDayData.sales += 1;
  analyticsDayData.volume = analyticsDayData.volume + sale.price;
  analyticsDayData.daoEarnings =
    analyticsDayData.daoEarnings +
    (feesCollectorCut * sale.price) / ONE_MILLION;

  return analyticsDayData;
}
