# Multichain squid for DCL

This [squid](https://docs.subsquid.io/) captures DCL related events on ETH and POLYGON, stores them in the same database and serves the data over a common GraphQL API.

The Ethereum processor is located in `src/eth` and similarly the Polygon can be found in `src/polygon`. The scripts file `commands.json` was updated with the commands `process:eth` and `process:polygon` to run the processors. 

You can find some useful hints on developing multichain squids on the [dedicated documentation page](https://docs.subsquid.io/basics/multichain/).

Dependencies: Node.js, Docker, Git.

## Quickstart

```bash
# 0. Install @subsquid/cli a.k.a. the sqd command globally
npm i -g @subsquid/cli

# 1. Clone the repo
git clone https://github.com/decentraland/marketplace-squid-core
cd marketplace-squid-core

# 2. Install dependencies
npm ci

# 3. Start a Postgres database container and detach
sqd up

# 4. Apply the migration
sqd migration:apply

# 5. Build the squid
sqd build

# 6. Run all services at once
sqd run .
```
A GraphiQL playground will be available at [localhost:4350/graphql](http://localhost:4350/graphql).

You can also run individual services separately:
```bash
sqd process:eth # Ethereum processor
sqd process:polygon # Polygon processor
sqd serve       # GraphQL server
```

## Deployment

On ECS, `indexer.sh` gives every new commit its own schema (`marketplace_squid_<timestamp>`) and user. The squid management server promotes a schema by renaming it to `squid_marketplace`, and the schema's grants come along.

Read access for other services is granted when the schema is created:

- The users hardcoded at the top of `indexer.sh`.
- `READER_ROLES`: an optional, space-separated list of extra roles. Each one gets `USAGE` and `SELECT` on the deployment schema and its two processor state schemas. Every role must already exist, or the deployment fails to start.

Grants only reach schemas created after a role is added. Grant a new role on the live `squid_marketplace` by hand.
