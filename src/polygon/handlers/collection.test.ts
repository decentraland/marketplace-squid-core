import { getCurator } from "./collection";

const MEMBER = "0x2a39d4f68133491f0442496f601cde2a945b6d31";
const RELAYER = "0x0000000000000000000000000000000000000b0b";
const word = (hex: string) => hex.padStart(64, "0");

describe("getCurator", () => {
  describe("when the committee member sends manageCollection", () => {
    it("should be the sender", () => {
      expect(
        getCurator({ input: `0x81c9308e${word("1")}`, from: MEMBER })
      ).toBe(MEMBER);
    });
  });

  describe("when a relayer forwards the member's meta transaction", () => {
    it("should be the meta transaction's signer, not the relayer", () => {
      const input = `0x07bd3522${word("2")}${word("3")}0c53c51c${word(
        MEMBER.slice(2)
      )}`;

      expect(getCurator({ input, from: RELAYER })).toBe(MEMBER);
    });
  });

  describe("when the transaction is anything else", () => {
    it("should be undefined", () => {
      expect(getCurator({ input: "0xa9059cbb", from: MEMBER })).toBeUndefined();
    });
  });
});
