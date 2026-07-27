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
const addresses = getAddresses(Network.MATIC);
const chainId = process.env.POLYGON_CHAIN_ID || ChainId.MATIC_MAINNET;

const fileName = `collections_${
  +chainId === ChainId.MATIC_MAINNET ? "mainnet" : "amoy"
}.json`;

// SQD Network Portal, the same dataset the processors read (see polygon/processor.ts). This used to
// point at `v2.archive.subsquid.io`, which STARTED REQUIRING AN API KEY on 19 May 2026 — after which
// every run of this tool died with `ArchiveCredentialsError: CREDENTIALS_INVALID` unless SQUID_API_KEY
// happened to be set in the shell. That is why the committed snapshot went stale, and staleness here is
// expensive: the processor can only address-filter collection logs up to the snapshot's height, and
// falls back to fetching EVERY ERC721 Transfer on the chain beyond it.
//
// The Portal needs no key, so this can be run by anyone (and by CI) without a secret.
const PORTAL_URL = `https://portal.sqd.dev/datasets/polygon-${
  chainId == ChainId.MATIC_MAINNET ? "mainnet" : "amoy-testnet"
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
  if (isReady) process.exit();
  if (ctx.isHead) isReady = true;

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
