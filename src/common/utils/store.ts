/**
 * Postgres takes at most 65,535 parameters in one query, and a batch can name more ids than that:
 * on Ethereum, the batch past block 9,534,650 read from chain-lake names some 70,000 accounts. Ids
 * are looked up this many at a time instead, well under the limit with the query's other parameters.
 */
export const MAX_IDS_PER_QUERY = 30000;

/** Runs `find` over `ids` in chunks of at most `MAX_IDS_PER_QUERY`, and joins what each finds. */
export async function findInChunks<I, E>(
  ids: I[],
  find: (chunk: I[]) => Promise<E[]>
): Promise<E[]> {
  const found: E[] = [];
  for (let start = 0; start < ids.length; start += MAX_IDS_PER_QUERY) {
    for (const entity of await find(ids.slice(start, start + MAX_IDS_PER_QUERY))) {
      found.push(entity);
    }
  }
  return found;
}
