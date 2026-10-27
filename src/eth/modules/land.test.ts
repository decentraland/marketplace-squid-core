import { decodeTokenIdsToCoordinates, isParcelTokenId } from "./land";

// x in the high 128 bits, y in the low 128 bits, each a two's complement int128.
const tokenId = (x: number, y: number) =>
  (BigInt.asUintN(128, BigInt(x)) << BigInt(128)) | BigInt.asUintN(128, BigInt(y));

// The asset id of the AuctionCancelled the 2018 marketplace logged at block 5,662,897, for an
// auction that never existed.
const NO_PARCEL = BigInt(
  "0x609303ecd3114cf31c815ecd2e818e44cfc057fc26318fccffc4154178dd57fa"
);

describe("isParcelTokenId", () => {
  describe("when the token id encodes coordinates inside the map's bounds", () => {
    it("should be a parcel, negative coordinates included", () => {
      expect(isParcelTokenId(tokenId(58, -23))).toBe(true);
      expect(isParcelTokenId(tokenId(-150, -150))).toBe(true);
      expect(isParcelTokenId(BigInt(0))).toBe(true);
    });
  });

  describe("when the token id encodes coordinates outside the bounds", () => {
    it("should not be a parcel", () => {
      expect(isParcelTokenId(NO_PARCEL)).toBe(false);
      expect(isParcelTokenId(tokenId(1000000, 0))).toBe(false);
      expect(isParcelTokenId(tokenId(0, -1000000))).toBe(false);
    });
  });
});

describe("decodeTokenIdsToCoordinates", () => {
  describe("when every token id is a parcel", () => {
    it("should decode each to its coordinates", () => {
      const id = tokenId(58, -23);
      expect(decodeTokenIdsToCoordinates(new Set([id])).get(id)).toEqual({
        _0: 58,
        _1: -23,
      });
    });
  });

  describe("when a token id is not a parcel", () => {
    it("should throw", () => {
      expect(() => decodeTokenIdsToCoordinates(new Set([NO_PARCEL]))).toThrow(
        "The coordinates should be inside bounds"
      );
    });
  });
});
