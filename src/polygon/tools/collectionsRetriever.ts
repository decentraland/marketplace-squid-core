import "dotenv/config";

import { ChainId, Network } from "@dcl/schemas";
import { run } from "@subsquid/batch-processor";
import { createLogger } from "@subsquid/logger";
import { DataSourceBuilder } from "@subsquid/evm-stream";
import { Database, LocalDest } from "@subsquid/file-store";
import { getAddresses } from "../../common/utils/addresses";
import * as CollectionFactoryABI from "../abi/CollectionFactory";
import * as CollectionFactoryV3ABI from "../abi/CollectionFactoryV3";

const fromsV1: Record<string, any> = {
  [ChainId.MATIC_MAINNET]: 15202000,
  [ChainId.MATIC_AMOY]: 14517370,
};

const fromsV3: Record<string, any> = {
  [ChainId.MATIC_MAINNET]: 28121692,
  [ChainId.MATIC_AMOY]: 5763249,
};

const logger = createLogger("sqd:collections-retriever");

// Resolve the chain ONCE and write it back to the environment BEFORE anything reads an address.
//
// `getAddresses` re-reads POLYGON_CHAIN_ID itself and compares it as a STRING, so anything that is not
// exactly "137" — including unset — resolves to Amoy. This tool defaults the same variable to mainnet.
// Left to disagree, a run picks the mainnet dataset, the mainnet start blocks and the mainnet filename,
// then filters all of it for the AMOY factory addresses: it matches nothing, runs happily to head, and
// writes a snapshot whose height advanced by millions of blocks while its address list did not grow.
//
// Committing that is worse than leaving the snapshot stale. The processor address-filters collection
// logs up to the recorded height, so every collection created inside the range the file CLAIMS to have
// scanned would become invisible to it.
const chainId = process.env.POLYGON_CHAIN_ID || ChainId.MATIC_MAINNET.toString();
process.env.POLYGON_CHAIN_ID = chainId;

const addresses = getAddresses(Network.MATIC);

// One derived flag for every network-dependent choice below. They used to be decided independently —
// one with `+chainId ===`, another with a loose `==` against a numeric enum — which is how the file
// name, the dataset and the addresses were able to disagree about which chain this run was for.
const isMainnet = +chainId === ChainId.MATIC_MAINNET;

const fileName = `collections_${isMainnet ? "mainnet" : "amoy"}.json`;

// SQD Network Portal, the same dataset the processors read (see polygon/processor.ts). This used to
// point at `v2.archive.subsquid.io`, which STARTED REQUIRING AN API KEY on 19 May 2026 — after which
// every run of this tool died with `ArchiveCredentialsError: CREDENTIALS_INVALID` unless SQUID_API_KEY
// happened to be set in the shell. That is why the committed snapshot went stale, and staleness here is
// expensive: the processor can only address-filter collection logs up to the snapshot's height, and
// falls back to fetching EVERY ERC721 Transfer on the chain beyond it.
//
// The Portal needs no key, so this can be run by anyone (and by CI) without a secret.
const PORTAL_URL = `https://portal.sqd.dev/datasets/polygon-${
  isMainnet ? "mainnet" : "amoy-testnet"
}`;

const dataSource = new DataSourceBuilder()
  .setPortal(PORTAL_URL)
  // Portal fetches ONLY the fields listed here — it does not merge in a default set.
  .setFields({
    block: { timestamp: true },
    log: { address: true, topics: true, data: true },
  })
  .addLog({
    where: {
      address: [addresses.CollectionFactory],
      topic0: [CollectionFactoryABI.events.ProxyCreated.topic],
    },
    range: { from: fromsV1[chainId] },
  })
  .addLog({
    where: {
      address: [addresses.CollectionFactoryV3],
      topic0: [CollectionFactoryV3ABI.events.ProxyCreated.topic],
    },
    range: { from: fromsV3[chainId] },
  })
  .build();

let collections: string[] = [];

type Metadata = {
  height: number;
  hash: string;
  addresses: string[];
};

let isInit = false;
let isReady = false;

// Where this run resumed from, and how big the address list was there. Both only to sanity-check the
// result at head — see the guard in the batch handler.
let startHeight: number | undefined;
let startCount = 0;
let lastHeight = 0;

// A run that scans further than this and finds NOTHING is reporting a broken filter, not a quiet chain.
// Sized well above a weekly run (~300k blocks on Polygon) so an ordinary refresh can never trip it, and
// well below the multi-million-block backfills where this actually went wrong.
const SUSPICIOUS_EMPTY_SCAN_BLOCKS = 1_000_000;

let db = new Database({
  tables: {},
  dest: new LocalDest("./assets"),
  chunkSizeMb: 10,
  hooks: {
    async onStateRead(dest) {
      if (await dest.exists(fileName)) {
        let { height, hash, addresses }: Metadata = await dest
          .readFile(fileName)
          .then(JSON.parse);

        if (!isInit) {
          collections = addresses;
          startHeight = height;
          startCount = addresses.length;
          isInit = true;
        }

        return { height, hash };
      } else {
        return undefined;
      }
    },
    async onStateUpdate(dest, info) {
      let metadata: Metadata = {
        ...info,
        addresses: collections,
      };
      // Pretty-printed on purpose: this file is COMMITTED, so a single-line array of hundreds of
      // addresses would make every regeneration an unreviewable one-line diff.
      await dest.writeFile(fileName, JSON.stringify(metadata, null, 2) + "\n");
    },
  },
});

run(dataSource, db, async (ctx) => {
  ctx.store.setForceFlush(true);
  if (isReady) {
    const scanned = lastHeight - (startHeight ?? lastHeight);
    const found = collections.length - startCount;
    // Reaching head proves the run finished, NOT that it worked. Scanning millions of blocks of a chain
    // this size without seeing a single ProxyCreated means the subscription matched nothing — a wrong
    // network's factory addresses, a changed topic, the wrong dataset. Exit non-zero so CI stops before
    // the commit step, and say plainly that the file on disk is now wrong.
    if (found === 0 && scanned > SUSPICIOUS_EMPTY_SCAN_BLOCKS) {
      logger.fatal(
        `Scanned ${scanned} blocks up to ${lastHeight} and found NO collections. ` +
          `Filtering on CollectionFactory=${addresses.CollectionFactory} ` +
          `CollectionFactoryV3=${addresses.CollectionFactoryV3} (POLYGON_CHAIN_ID=${chainId}). ` +
          `${fileName} now claims that height with an unchanged address list — DISCARD it, do not commit.`
      );
      process.exit(1);
    }
    logger.info(`done: +${found} collections over ${scanned} blocks, head ${lastHeight}`);
    process.exit();
  }
  if (ctx.isHead) isReady = true;
  if (ctx.blocks.length > 0) {
    lastHeight = ctx.blocks[ctx.blocks.length - 1].header.height;
  }

  for (let c of ctx.blocks) {
    for (let i of c.logs) {
      if (
        [addresses.CollectionFactory, addresses.CollectionFactoryV3]
          .map((c) => c.toLowerCase())
          .includes(i.address)
      ) {
        const { _address } = CollectionFactoryABI.events.ProxyCreated.decode(i);
        collections.push(_address.toLowerCase());
        logger.info(`collections: ${collections.length}`);
      }
    }
  }
});
