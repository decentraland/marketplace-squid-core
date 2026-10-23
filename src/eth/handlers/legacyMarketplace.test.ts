import { Network } from "@dcl/schemas";
import { getAddresses } from "../../common/utils/addresses";
import { NFT, Order, OrderStatus } from "../../model";
import type { BlockData } from "../processor";
import {
  handleAuctionCancelled,
  handleAuctionCreated,
  handleAuctionSuccessful,
} from "./legacyMarketplace";

const LEGACY = "0xb3bca6f5052c7e24726b44da7403b56a8a1b98f8";
// The network the tests run on decides the address, as it does for the handlers.
const LAND = getAddresses(Network.ETHEREUM).LANDRegistry;
const SELLER = "0x0000000000000000000000000000000000000a11";
const WINNER = "0x0000000000000000000000000000000000000b0b";
const ASSET = BigInt(42);
const NFT_ID = `parcel-${LAND}-42`;

const blockAt = (height: number, seconds: number) =>
  ({ header: { height, timestamp: seconds * 1000 } }) as unknown as BlockData;
const created = (id: string) => ({
  id,
  assetId: ASSET,
  seller: SELLER,
  priceInWei: BigInt(1000),
  expiresAt: BigInt(1526947200000),
});

describe("the LAND marketplace of 2018", () => {
  let orders: Map<string, Order>;
  let nft: NFT;

  beforeEach(() => {
    orders = new Map();
    nft = new NFT({ id: NFT_ID, activeOrder: null });
  });

  describe("when an auction is created", () => {
    beforeEach(() => {
      handleAuctionCreated(
        created("0x01"),
        blockAt(5_286_820, 1521473302),
        LEGACY,
        "0xtx",
        orders,
        new Map([[NFT_ID, nft]])
      );
    });

    it("should keep it as an open order of the parcel", () => {
      expect(orders.get("0x01")).toEqual(
        expect.objectContaining({
          marketplaceAddress: LEGACY,
          status: OrderStatus.open,
          category: "parcel",
          nftAddress: LAND,
          tokenId: ASSET,
          owner: SELLER,
          price: BigInt(1000),
          createdAt: BigInt(1521473302),
          txHash: "0xtx",
        })
      );
    });

    it("should not make it the parcel's active order", () => {
      expect(nft.activeOrder).toBeNull();
    });

    describe("and another one replaces it", () => {
      beforeEach(() => {
        handleAuctionCreated(
          created("0x02"),
          blockAt(5_300_000, 1521500000),
          LEGACY,
          "0xtx2",
          orders,
          new Map([[NFT_ID, nft]])
        );
      });

      it("should cancel the first one", () => {
        expect(orders.get("0x01")?.status).toBe(OrderStatus.cancelled);
        expect(orders.get("0x01")?.updatedAt).toBe(BigInt(1521500000));
        expect(orders.get("0x02")?.status).toBe(OrderStatus.open);
      });
    });

    describe("and it sells", () => {
      beforeEach(() => {
        handleAuctionSuccessful(
          {
            id: "0x01",
            assetId: ASSET,
            seller: SELLER,
            totalPrice: BigInt(900),
            winner: WINNER,
          },
          blockAt(5_946_827, 1531342476),
          orders
        );
      });

      it("should mark it sold to the winner at the price paid", () => {
        expect(orders.get("0x01")).toEqual(
          expect.objectContaining({
            status: OrderStatus.sold,
            buyer: WINNER,
            price: BigInt(900),
            updatedAt: BigInt(1531342476),
          })
        );
      });
    });

    describe("and it is cancelled", () => {
      beforeEach(() => {
        handleAuctionCancelled(
          { id: "0x01", assetId: ASSET, seller: SELLER },
          blockAt(23_000_000, 1784859539),
          orders
        );
      });

      it("should mark it cancelled", () => {
        expect(orders.get("0x01")).toEqual(
          expect.objectContaining({
            status: OrderStatus.cancelled,
            updatedAt: BigInt(1784859539),
            blockNumber: BigInt(23_000_000),
          })
        );
      });
    });
  });

  describe("when an auction is created for a parcel the squid does not hold", () => {
    it("should keep no order", () => {
      handleAuctionCreated(
        created("0x01"),
        blockAt(5_286_820, 1521473302),
        LEGACY,
        "0xtx",
        orders,
        new Map()
      );

      expect(orders.size).toBe(0);
    });
  });
});
