import { findInChunks, MAX_IDS_PER_QUERY } from "./store";

describe("findInChunks", () => {
  let find: jest.Mock<Promise<{ id: number }[]>, [number[]]>;

  beforeEach(() => {
    find = jest.fn(async (chunk: number[]) => chunk.map((id) => ({ id })));
  });

  describe("when there are no ids", () => {
    it("should not query and find nothing", async () => {
      expect(await findInChunks([], find)).toEqual([]);
      expect(find).not.toHaveBeenCalled();
    });
  });

  describe("when the ids fit in one query", () => {
    it("should query once with all of them", async () => {
      const ids = [1, 2, 3];
      expect(await findInChunks(ids, find)).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
      expect(find).toHaveBeenCalledTimes(1);
      expect(find).toHaveBeenCalledWith(ids);
    });
  });

  describe("when there are more ids than one query takes", () => {
    let ids: number[];

    beforeEach(() => {
      // As many as the Ethereum batch past block 9,534,650 named, past Postgres' 65,535 parameters.
      ids = Array.from({ length: 69831 }, (_, i) => i);
    });

    it("should query them in chunks of at most MAX_IDS_PER_QUERY and join what each finds", async () => {
      const found = await findInChunks(ids, find);
      expect(find).toHaveBeenCalledTimes(3);
      for (const [chunk] of find.mock.calls) {
        expect(chunk.length).toBeLessThanOrEqual(MAX_IDS_PER_QUERY);
      }
      expect(found.map(({ id }) => id)).toEqual(ids);
    });
  });
});
