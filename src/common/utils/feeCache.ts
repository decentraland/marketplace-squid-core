/**
 * A per-contract configuration cache that survives batches without trusting them.
 *
 * The values it holds are read from chain once and then kept current by ingesting the contract's own
 * update events. They end up in a Sale's money columns, so a wrong one is silent financial corruption
 * rather than a crash, and the cache lives in process memory while the rows live in a database
 * transaction. Those two commit on different schedules: a batch that throws is retried in the same
 * process, so memory is not rolled back with the data.
 *
 * Hence three tiers. Writes made while a batch runs go to a staged map, so a retry cannot read values
 * the failed attempt learned. When the batch ends its writes are parked rather than committed, because
 * a handler has no way to know the transaction committed. The next batch's start block is the evidence:
 * the processor only advances past a range it has committed.
 *
 * That evidence is weaker for a handler that catches its own errors, since it advances whether or not
 * the batch did what it meant to. Promotion stays safe there because every value held came from the
 * chain or from an ingested log rather than from the batch's own work, but do not lean on the premise
 * for anything else.
 */
export type FeeCache<T extends object> = {
  /** Opens a batch's staging area, deciding the previous batch's fate from where this one starts. */
  begin(fromBlock: number): void;
  /** Ends the batch, parking its writes until a later batch shows the processor moved past `toBlock`. */
  end(toBlock: number): void;
  /** Committed values under the open batch's staged writes. */
  view(key: string): T;
  /** Records a patch against the open batch, or straight to the committed map outside one. */
  write(key: string, patch: Partial<T>): void;
  /** Empties every tier. For tests. */
  reset(): void;
};

export function createFeeCache<T extends object>(
  empty: () => T,
  merge: (base: T, patch: Partial<T>) => T
): FeeCache<T> {
  const committed = new Map<string, T>();
  let staged: Map<string, T> | null = null;
  let pending: { fromBlock: number; toBlock: number; writes: Map<string, T> } | null =
    null;
  let promotedToBlock = -1;
  let openedAtBlock = -1;

  const promote = (writes: Map<string, T>) => {
    for (const [key, patch] of writes) {
      committed.set(key, merge(committed.get(key) ?? empty(), patch));
    }
  };

  return {
    /**
     * A start after the previous batch's end promotes its writes. A start at or before an already
     * promoted block is a rollback into promoted history, so the whole cache goes.
     *
     * Anything else is a re-delivery of the parked batch, and dropping its writes is only safe while
     * the re-delivery replays them. One starting at or before that batch did covers all of it, so
     * forgetting is enough. One starting INSIDE it never replays the updates before its own start, and
     * an entry that is fully populated never reads the chain again, so those entries are invalidated
     * instead: that costs a read and re-seeds them, rather than keeping a value that is now wrong.
     */
    begin(fromBlock: number) {
      const parked = pending;
      pending = null;
      if (fromBlock <= promotedToBlock) {
        committed.clear();
        promotedToBlock = -1;
      } else if (parked) {
        if (fromBlock > parked.toBlock) {
          promote(parked.writes);
          promotedToBlock = parked.toBlock;
        } else if (fromBlock > parked.fromBlock) {
          for (const key of parked.writes.keys()) {
            committed.delete(key);
          }
        }
      }
      openedAtBlock = fromBlock;
      staged = new Map();
    },

    end(toBlock: number) {
      if (staged) {
        pending = { fromBlock: openedAtBlock, toBlock, writes: staged };
      }
      staged = null;
    },

    view(key: string): T {
      const normalized = key.toLowerCase();
      return merge(
        committed.get(normalized) ?? empty(),
        staged?.get(normalized) ?? empty()
      );
    },

    write(key: string, patch: Partial<T>) {
      const normalized = key.toLowerCase();
      // Outside a batch (tests, tooling) writes go straight to the committed map.
      const target = staged ?? committed;
      target.set(normalized, merge(target.get(normalized) ?? empty(), patch));
    },

    reset() {
      committed.clear();
      staged = null;
      pending = null;
      promotedToBlock = -1;
      openedAtBlock = -1;
    },
  };
}
