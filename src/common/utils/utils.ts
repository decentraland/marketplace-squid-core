export const ONE_MILLION = BigInt(1000000);

/**
 * Used for parseCSV() below
 */
enum CSVState {
  BETWEEN = 0,
  UNQUOTED_VALUE = 1,
  QUOTED_VALUE = 2,
}

/**
 * Parses a CSV string into an array of strings.
 * @param csv CSV string.
 * @returns Array of strings.
 */
export function parseCSV(csv: string): Array<string> {
  let values = new Array<string>();
  let valueStart = 0;
  let state = CSVState.BETWEEN;

  for (let i: number = 0; i < csv.length; i++) {
    if (state == CSVState.BETWEEN) {
      if (csv[i] != ",") {
        if (csv[i] == '"') {
          state = CSVState.QUOTED_VALUE;
          valueStart = i + 1;
        } else {
          state = CSVState.UNQUOTED_VALUE;
          valueStart = i;
        }
      }
    } else if (state == CSVState.UNQUOTED_VALUE) {
      if (csv[i] == ",") {
        values.push(csv.substr(valueStart, i - valueStart));
        state = CSVState.BETWEEN;
      }
    } else if (state == CSVState.QUOTED_VALUE) {
      if (csv[i] == '"') {
        values.push(csv.substr(valueStart, i - valueStart));
        state = CSVState.BETWEEN;
      }
    }
  }

  return values;
}

export function normalizeTimestamp(timestamp: bigint): Date {
  const timestampStr = timestamp.toString();

  if (timestampStr.length === 13) {
    return new Date(Number(timestamp)); // Handle milliseconds
  } else if (timestampStr.length === 10) {
    return new Date(Number(timestamp) * 1000); // Handle seconds (convert to milliseconds)
  } else {
    return new Date(); // Handle invalid timestamps (more than 13 characters)
  }
}

// PostgreSQL TEXT columns cannot store the NUL byte (U+0000). An event that carries one - Estate or
// parcel metadata, a collection name or symbol, an ENS subdomain - would make the entity write throw
// `invalid byte sequence for encoding "UTF8": 0x00`, aborting the whole batch transaction. The batch
// processor then retries the same batch and fails again on every attempt, wedging the indexer at that
// block. These strings are cleaned before they reach a TEXT column so a single event cannot stall it.
export function stripNul(value: string): string {
  return value.replace(/\u0000/g, "");
}
