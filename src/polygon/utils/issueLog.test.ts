import { IssueLogLike, selectIssueLogForTrade } from "./issueLog";

const ISSUE_TOPIC =
  "0x57e2fe3f7dcd918a54e57b2dc0da8e347386daa9d69c3bbf6c8bce2f7e8398c7";
const COLLECTION = "0x03b1940d80394614a5ba60abbf73fa749068bdad";
const OTHER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// itemId is the indexed 4th topic of the Issue event (padded to 32 bytes).
const topicForItem = (itemId: number) =>
  "0x" + itemId.toString(16).padStart(64, "0");

const issueLog = (
  logIndex: number,
  itemId: number,
  overrides: Partial<IssueLogLike> = {}
): IssueLogLike => ({
  transactionIndex: 0,
  address: COLLECTION,
  topics: [ISSUE_TOPIC, "0x", "0x", topicForItem(itemId)],
  logIndex,
  ...overrides,
});

describe("selectIssueLogForTrade", () => {
  const baseParams = () => ({
    transactionIndex: 0,
    collectionAddress: COLLECTION,
    issueTopic: ISSUE_TOPIC,
    blockHeight: 42899045,
    consumedIssueLogs: new Set<string>(),
  });

  it("when a tx mints the same item twice it returns a distinct Issue log per call", () => {
    // Mirrors tx 0xa49ba5...: item 5 issued twice, item 15 once, all via OffChainMarketplace.
    const logs: IssueLogLike[] = [
      issueLog(3, 5), // item 5, issued #1
      issueLog(10, 5), // item 5, issued #2
      issueLog(17, 15), // item 15, issued #1
    ];
    const consumed = new Set<string>();
    const params = { ...baseParams(), consumedIssueLogs: consumed };

    const first = selectIssueLogForTrade(logs, { ...params, itemId: 5n });
    const second = selectIssueLogForTrade(logs, { ...params, itemId: 5n });
    const third = selectIssueLogForTrade(logs, { ...params, itemId: 15n });

    if (!first || !second || !third) {
      throw new Error("all three mints must resolve a log");
    }
    // first item-5 Traded -> issued #1; second -> issued #2 (previously dropped); item-15 -> its own log
    expect(first.logIndex).toBe(3);
    expect(second.logIndex).toBe(10);
    expect(third.logIndex).toBe(17);
    expect(first.logIndex).not.toBe(second.logIndex);
  });

  it("when there is a single mint it returns that log", () => {
    const logs = [issueLog(3, 5)];
    const chosen = selectIssueLogForTrade(logs, {
      ...baseParams(),
      itemId: 5n,
    });
    expect(chosen?.logIndex).toBe(3);
  });

  it("when there are no more unconsumed logs it returns undefined", () => {
    const logs = [issueLog(3, 5)];
    const params = { ...baseParams(), itemId: 5n };
    expect(selectIssueLogForTrade(logs, params)).toBeTruthy();
    // the single Issue log is consumed and not reused
    expect(selectIssueLogForTrade(logs, params)).toBeUndefined();
  });

  it("when logs are out of order it consumes them in ascending logIndex order", () => {
    const logs = [issueLog(10, 5), issueLog(3, 5)];
    const params = { ...baseParams(), itemId: 5n };
    const first = selectIssueLogForTrade(logs, params);
    const second = selectIssueLogForTrade(logs, params);
    expect(first?.logIndex).toBe(3);
    expect(second?.logIndex).toBe(10);
  });

  it("when logs belong to another item, tx or contract they are ignored", () => {
    const logs: IssueLogLike[] = [
      issueLog(3, 15), // different item
      issueLog(4, 5, { transactionIndex: 9 }), // different tx
      issueLog(5, 5, { address: "0xdeadbeef" }), // different contract
      issueLog(6, 5, { topics: [OTHER_TOPIC, "0x", "0x", topicForItem(5)] }), // not an Issue
      issueLog(7, 5), // the only valid match
    ];
    const chosen = selectIssueLogForTrade(logs, {
      ...baseParams(),
      itemId: 5n,
    });
    expect(chosen?.logIndex).toBe(7);
  });
});
