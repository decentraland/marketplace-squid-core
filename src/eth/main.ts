import { TypeormDatabase } from "@subsquid/typeorm-store";
import { Network } from "@dcl/schemas";
import * as landRegistryABI from "../abi/LANDRegistry";
import * as erc721abi from "../abi/ERC721";
import * as estateRegistryABI from "../abi/EstateRegistry";
import * as dclRegistrarAbi from "../abi/DCLRegistrar";
import * as marketplaceAbi from "../abi/Marketplace";
import * as erc721Bid from "../abi/ERC721Bid";
import * as dclControllerV2abi from "../abi/DCLControllerV2";
import * as MarketplaceV3ABI from "../abi/DecentralandMarketplaceEthereum";
import * as SpokeABI from "../abi/Spoke";
import { Order, Sale, Transfer, Network as ModelNetwork } from "../model";
import { processor } from "./processor";
import { getNFTId } from "../common/utils";
import { tokenURIMutilcall } from "../common/utils/multicall";
import { getAddresses } from "../common/utils/addresses";
import {
  handleAddLand,
  handleCreateEstate,
  handleRemoveLand,
  handleUpdate as handleEstateUpdate,
  isAddLandEvent,
  isCreateEstateEvent,
  isRemoveLandEvent,
  isUpdateEvent,
} from "./handlers/estate";
import { handleUpdate as handleLandUpdate } from "./handlers/parcel";
import { Coordinate } from "../types";
import { getCategory } from "../common/utils/category";
import {
  addEventToStateIdsBasedOnCategory,
  getBidOwnerCutPerMillion,
  getBatchInMemoryState,
  getOwnerCutsValues,
  getMarketplaceOwnerCutPerMillion,
  setMarketplaceOwnerCutPerMillion,
  setBidOwnerCutPerMillion,
} from "./state";
import { handleNameBought, handleNameRegistered } from "./handlers/ens";
import {
  handleOrderCancelled,
  handleOrderCreated,
  handleOrderSuccessful,
  handleTraded,
} from "./handlers/marketplace";
import { getStoredData } from "./store";
import { decodeTokenIdsToCoordinates } from "./modules/land";
import {
  handleBidAccepted,
  handleBidCancelled,
  handleBidCreated,
} from "./handlers/bid";
import {
  handleAddItemV1,
  handleTransfer,
  handleTransferWearableV1,
} from "./handlers/nft";
import { getBidId } from "../common/handlers/bid";
import { handleInitializeWearablesV1 } from "./handlers/collection";
import { getItemId } from "../polygon/modules/item";
import { getWearableIdFromTokenURI } from "./modules/wearable";
import {
  getTradeEventData,
  getTradeEventType,
} from "../common/utils/marketplaceV3";

const landCoordinates: Map<bigint, Coordinate> = new Map();
const tokenURIs: Map<string, string> = new Map();

let bytesRead = 0; // amount of bytes received

const schemaName = process.env.DB_SCHEMA;
processor.run(
  new TypeormDatabase({
    isolationLevel: "READ COMMITTED",
    supportHotBlocks: true,
    stateSchema: `eth_processor_${schemaName}`,
  }),
  async (ctx) => {
    // ============ BENCHMARKING: Start total time ============
    const batchStartTime = Date.now();
    const metrics = {
      blockRange: `${ctx.blocks[0]?.header.height}-${ctx.blocks[ctx.blocks.length - 1]?.header.height}`,
      eventAccumulationTime: 0,
      dbQueryTime: 0,
      eventProcessingTime: 0,
      upsertTime: 0,
      eventsProcessed: 0,
      rpcCalls: 0,
      skipped: false,
    };

    // update the amount of bytes read
    bytesRead += ctx.blocks.reduce(
      (acc, block) => acc + Buffer.byteLength(JSON.stringify(block), "utf8"),
      0
    );
    console.log("bytesRead: ", bytesRead);
    const addresses = getAddresses(Network.ETHEREUM);

    // ============ OPTIMIZATION #5: Skip Empty Batches ============
    const relevantAddresses = new Set([
      addresses.LANDRegistry?.toLowerCase(),
      addresses.EstateRegistry?.toLowerCase(),
      addresses.DCLRegistrar?.toLowerCase(),
      addresses.Marketplace?.toLowerCase(),
      addresses.ERC721Bid?.toLowerCase(),
      addresses.DCLControllerV2?.toLowerCase(),
      addresses.MarketplaceV3?.toLowerCase(),
      addresses.MarketplaceV3_V2?.toLowerCase(),
      addresses.Spoke?.toLowerCase(),
      ...Object.values(addresses.collections || {}).map((addr) => (addr as string)?.toLowerCase()),
    ].filter(Boolean));

    const hasRelevantEvents = ctx.blocks.some(block =>
      block.logs.some(log => relevantAddresses.has(log.address.toLowerCase()))
    );

    if (!hasRelevantEvents) {
      metrics.skipped = true;
      ctx.log.info(`⏭️ SKIPPED empty batch: ${metrics.blockRange} (no DCL events)`);
      console.log(`📊 METRICS: ${JSON.stringify(metrics)}`);
      return;
    }

    const {
      mints,
      collectionIds,
      itemIds,
      accountIds,
      estateTokenIds,
      landTokenIds,
      ensTokenIds,
      parcelEvents,
      tokenIds,
      transfers,
      bidIds,
      ensEvents,
      markteplaceEvents,
      analyticsIds,
    } = getBatchInMemoryState();

    ctx.log.info(`blocks, ${ctx.blocks.length}`);

    // ============ OPTIMIZATION #1: Fetch owner cuts ONCE per batch ============
    const eventAccumulationStart = Date.now();
    await getOwnerCutsValues(ctx, ctx.blocks[0]);
    metrics.rpcCalls++;
    console.log(`⚡ Owner cuts fetched ONCE for entire batch (was: per block)`);

    for (let block of ctx.blocks) {
      // REMOVED: await getOwnerCutsValues(ctx, block); - now fetched once above!
      for (let log of block.logs) {
        metrics.eventsProcessed++;
        const topic = log.topics[0];
        const timestamp = BigInt(block.header.timestamp / 1000);
        const analyticDayDataId = `${(
          BigInt(timestamp) / BigInt(86400)
        ).toString()}-${ModelNetwork.ETHEREUM}`;
        switch (topic) {
          case erc721abi.events[
            "Transfer(address indexed,address indexed,uint256 indexed,address,bytes,bytes)"
          ].topic:
          case erc721abi.events[
            "Transfer(address indexed,address indexed,uint256 indexed,address,bytes)"
          ].topic:
          case erc721abi.events[
            "Transfer(address indexed,address indexed,uint256 indexed)"
          ].topic:
          case erc721abi.events[
            "Transfer(address indexed,address indexed,uint256)"
          ].topic: {
            let event;
            if (
              topic ===
              erc721abi.events[
                "Transfer(address indexed,address indexed,uint256)"
              ].topic
            ) {
              event =
                erc721abi.events[
                  "Transfer(address indexed,address indexed,uint256 indexed)"
                ].decode(log);
            } else if (
              topic ===
              erc721abi.events[
                "Transfer(address indexed,address indexed,uint256 indexed)"
              ].topic
            ) {
              event =
                erc721abi.events[
                  "Transfer(address indexed,address indexed,uint256 indexed)"
                ].decode(log);
            } else if (
              topic ===
              erc721abi.events[
                "Transfer(address indexed,address indexed,uint256 indexed,address,bytes)"
              ].topic
            ) {
              event =
                erc721abi.events[
                  "Transfer(address indexed,address indexed,uint256 indexed,address,bytes)"
                ].decode(log);
            } else if (
              topic ===
              erc721abi.events[
                "Transfer(address indexed,address indexed,uint256 indexed,address,bytes,bytes)"
              ].topic
            ) {
              event =
                erc721abi.events[
                  "Transfer(address indexed,address indexed,uint256 indexed,address,bytes,bytes)"
                ].decode(log);
            }

            if (!event) {
              console.log("ERROR: event could not be decoded");
              break;
            }

            const contractAddress = log.address;
            markteplaceEvents.push({
              topic,
              event: {
                from: event.from,
                to: event.to,
                tokenId: event.tokenId,
              },
              block,
              log,
              marketplaceOwnerCutPerMillion: getMarketplaceOwnerCutPerMillion(),
              bidOwnerCutPerMillion: getBidOwnerCutPerMillion(),
            });

            accountIds.add(event.to.toString()); // we'll need the accounts to update some fields
            switch (contractAddress) {
              case addresses.LANDRegistry:
                landTokenIds.add(event.tokenId);
                break;
              case addresses.EstateRegistry:
                estateTokenIds.add(event.tokenId);
                break;
              case addresses.DCLRegistrar:
                ensTokenIds.add(event.tokenId);
                break;
              default:
                tokenIds.set(contractAddress, [
                  ...(tokenIds.get(contractAddress) || []),
                  event.tokenId,
                ]);
                // @TODO: check how to improve this
                const tokenURI = tokenURIs.get(
                  `${contractAddress}-${event.tokenId}`
                );
                if (tokenURI) {
                  const representationId = getWearableIdFromTokenURI(tokenURI);
                  const itemId = getItemId(contractAddress, representationId);
                  itemIds.set(contractAddress, [
                    ...(itemIds.get(contractAddress) || []),
                    itemId,
                  ]);
                }

                break;
            }
            const category = getCategory(Network.ETHEREUM, contractAddress);
            const nftId = getNFTId(
              contractAddress,
              event.tokenId.toString(),
              category
            );
            const timestamp = block.header.timestamp / 1000;
            transfers.set(
              `${nftId}-${timestamp}`,
              new Transfer({
                id: `${nftId}-${timestamp}`,
                nftId,
                block: block.header.height,
                from: event.from,
                to: event.to,
                // network: Network.ETHEREUM.toString(),
                network: ModelNetwork.ETHEREUM,
                timestamp: BigInt(timestamp),
                txHash: log.transactionHash,
              })
            );
            break;
          }
          case erc721abi.events.OwnershipTransferred.topic: {
            markteplaceEvents.push({
              topic,
              event: erc721abi.events.OwnershipTransferred.decode(log),
              block,
              log,
            });
            break;
          }
          case erc721abi.events.AddWearable.topic: {
            collectionIds.add(log.address.toLowerCase());
            markteplaceEvents.push({
              topic,
              event: erc721abi.events.AddWearable.decode(log),
              block,
              log,
            });
            break;
          }
          case estateRegistryABI.events.CreateEstate.topic: {
            markteplaceEvents.push({
              topic,
              event: estateRegistryABI.events.CreateEstate.decode(log),
              block,
              log,
            });
            break;
          }
          case landRegistryABI.events.Update.topic:
          case estateRegistryABI.events.Update.topic: {
            if (log.address === addresses.EstateRegistry) {
              const event = estateRegistryABI.events.Update.decode(log);
              estateTokenIds.add(event._assetId);
              markteplaceEvents.push({
                topic,
                event,
                block,
                log,
              });
            } else if (log.address === addresses.LANDRegistry) {
              const event = landRegistryABI.events.Update.decode(log);
              landTokenIds.add(event.assetId);
              parcelEvents.push({
                topic,
                event,
                block,
              });
            }
            break;
          }
          case estateRegistryABI.events.AddLand.topic: {
            const event = estateRegistryABI.events.AddLand.decode(log);
            estateTokenIds.add(event._estateId);
            markteplaceEvents.push({
              topic: estateRegistryABI.events.AddLand.topic,
              event,
              block,
              log,
            });
            break;
          }
          case estateRegistryABI.events.RemoveLand.topic: {
            const event = estateRegistryABI.events.RemoveLand.decode(log);
            estateTokenIds.add(event._estateId);
            markteplaceEvents.push({
              topic: estateRegistryABI.events.RemoveLand.topic,
              event,
              block,
              log,
            });

            break;
          }
          // ens
          case dclRegistrarAbi.events.NameRegistered.topic:
            ensEvents.push({
              topic,
              event: dclRegistrarAbi.events.NameRegistered.decode(log),
              block,
              log,
            });
            break;
          case dclControllerV2abi.events.NameBought.topic:
            analyticsIds.add(analyticDayDataId);
            ensEvents.push({
              topic,
              event: dclControllerV2abi.events.NameBought.decode(log),
              block,
              log,
            });

            // const analyticsDayData = getOrCreateAnalyticsDayData(
            //   BigInt(block.header.timestamp / 1000),
            //   analytics
            // );
            // analytics.set(analyticsDayData.id, analyticsDayData);
            // let dayData = getOrCreateAnalyticsDayData(event.block.timestamp)

            // dayData.daoEarnings = dayData.daoEarnings.plus(event.params._price)

            // dayData.save()
            // }
            // ensEvents.push(dclControllerV2abi.events.NameBought.decode(log));
            break;
          // order events
          case marketplaceAbi.events.OrderCreated.topic: {
            const event = marketplaceAbi.events.OrderCreated.decode(log);
            addEventToStateIdsBasedOnCategory(event.nftAddress, event.assetId, {
              landTokenIds,
              estateTokenIds,
              ensTokenIds,
              tokenIds,
            });

            markteplaceEvents.push({
              topic,
              event,
              block,
              log,
              marketplaceOwnerCutPerMillion: getMarketplaceOwnerCutPerMillion(),
              bidOwnerCutPerMillion: getBidOwnerCutPerMillion(),
            });
            break;
          }
          case marketplaceAbi.events.OrderSuccessful.topic: {
            const event = marketplaceAbi.events.OrderSuccessful.decode(log);
            addEventToStateIdsBasedOnCategory(event.nftAddress, event.assetId, {
              landTokenIds,
              estateTokenIds,
              ensTokenIds,
              tokenIds,
            });
            accountIds.add(event.seller); // load sellers acount to update metrics
            accountIds.add(event.buyer); // load buyers acount to update metrics

            analyticsIds.add(analyticDayDataId);
            markteplaceEvents.push({
              topic,
              event,
              block,
              log,
              marketplaceOwnerCutPerMillion: getMarketplaceOwnerCutPerMillion(),
              bidOwnerCutPerMillion: getBidOwnerCutPerMillion(),
            });
            break;
          }
          case marketplaceAbi.events.OrderCancelled.topic: {
            const event = marketplaceAbi.events.OrderCancelled.decode(log);
            addEventToStateIdsBasedOnCategory(event.nftAddress, event.assetId, {
              landTokenIds,
              estateTokenIds,
              ensTokenIds,
              tokenIds,
            });
            markteplaceEvents.push({
              topic,
              event,
              block,
              log,
              marketplaceOwnerCutPerMillion: getMarketplaceOwnerCutPerMillion(),
              bidOwnerCutPerMillion: getBidOwnerCutPerMillion(),
            });
            break;
          }
          case marketplaceAbi.events.ChangedOwnerCutPerMillion.topic:
          case erc721Bid.events.ChangedOwnerCutPerMillion.topic: {
            const event =
              marketplaceAbi.events.ChangedOwnerCutPerMillion.decode(log);
            if (log.address === addresses.Marketplace) {
              setMarketplaceOwnerCutPerMillion(event.ownerCutPerMillion);
            } else {
              setBidOwnerCutPerMillion(event.ownerCutPerMillion);
            }
            break;
          }
          // bid events
          case erc721Bid.events.BidCreated.topic: {
            const event = erc721Bid.events.BidCreated.decode(log);
            addEventToStateIdsBasedOnCategory(
              event._tokenAddress,
              event._tokenId,
              {
                landTokenIds,
                estateTokenIds,
                ensTokenIds,
                tokenIds,
              }
            );
            markteplaceEvents.push({
              topic: erc721Bid.events.BidCreated.topic,
              event,
              block,
              log,
              marketplaceOwnerCutPerMillion: getMarketplaceOwnerCutPerMillion(),
              bidOwnerCutPerMillion: getBidOwnerCutPerMillion(),
            });
            break;
          }
          case erc721Bid.events.BidAccepted.topic: {
            const event = erc721Bid.events.BidAccepted.decode(log);
            const bidId = getBidId(
              event._tokenAddress,
              event._tokenId.toString(),
              event._bidder
            );
            analyticsIds.add(analyticDayDataId);
            accountIds.add(event._seller); // load sellers acount to update metrics
            accountIds.add(event._bidder); // load buyers acount to update metrics
            bidIds.add(bidId);
            addEventToStateIdsBasedOnCategory(
              event._tokenAddress,
              event._tokenId,
              {
                landTokenIds,
                estateTokenIds,
                ensTokenIds,
                tokenIds,
              }
            );
            markteplaceEvents.push({
              topic: erc721Bid.events.BidAccepted.topic,
              event,
              block,
              log,
              marketplaceOwnerCutPerMillion: getMarketplaceOwnerCutPerMillion(),
              bidOwnerCutPerMillion: getBidOwnerCutPerMillion(),
            });
            break;
          }
          case erc721Bid.events.BidCancelled.topic: {
            const event = erc721Bid.events.BidCancelled.decode(log);
            const bidId = getBidId(
              event._tokenAddress,
              event._tokenId.toString(),
              event._bidder
            );
            bidIds.add(bidId);
            addEventToStateIdsBasedOnCategory(
              event._tokenAddress,
              event._tokenId,
              {
                landTokenIds,
                estateTokenIds,
                ensTokenIds,
                tokenIds,
              }
            );
            markteplaceEvents.push({
              topic: erc721Bid.events.BidCancelled.topic,
              event,
              block,
              log,
              marketplaceOwnerCutPerMillion: getMarketplaceOwnerCutPerMillion(),
              bidOwnerCutPerMillion: getBidOwnerCutPerMillion(),
            });
            break;
          }
          case MarketplaceV3ABI.events.Traded.topic: {
            const event = MarketplaceV3ABI.events.Traded.decode(log);
            const tradeData = getTradeEventData(event, Network.ETHEREUM);
            const { collectionAddress, tokenId, buyer, seller } = tradeData;

            if (!tokenId) {
              console.log(`ERROR: tokenId not found in trade event`);
              break;
            }

            addEventToStateIdsBasedOnCategory(collectionAddress, tokenId, {
              landTokenIds,
              estateTokenIds,
              ensTokenIds,
              tokenIds,
            });

            accountIds.add(seller); // load sellers acount to update metrics
            accountIds.add(buyer); // load buyers acount to update metrics
            analyticsIds.add(analyticDayDataId);

            markteplaceEvents.push({
              topic,
              event,
              block,
              log,
            });

            break;
          }
        }
      }
    }

    metrics.eventAccumulationTime = Date.now() - eventAccumulationStart;

    if (tokenIds.size) {
      console.time("multicall tokenURIs");
    }

    const tokenIdsWithoutTokenURIs = new Map<string, bigint[]>();
    for (const [contractAddress, ids] of tokenIds.entries()) {
      const newIds = new Set<bigint>();
      for (const id of ids) {
        const tokenURI = tokenURIs.get(`${contractAddress}-${id}`);
        if (!tokenURI) {
          newIds.add(id);
        }
      }
      if (newIds.size > 0) {
        tokenIdsWithoutTokenURIs.set(contractAddress, [...newIds.values()]);
      }
    }

    const newTokenURIs =
      tokenIdsWithoutTokenURIs.size > 0
        ? await tokenURIMutilcall(
            ctx,
            ctx.blocks[ctx.blocks.length - 1].header, // use latest block of the batch to multicall fetch
            tokenIdsWithoutTokenURIs
          )
        : new Map<string, string>();

    if (tokenIds.size) {
      console.timeEnd("multicall tokenURIs");
    }

    [...newTokenURIs.entries()].forEach(([contractAndTokenId, value]) => {
      const tokenURI = value;
      tokenURIs.set(contractAndTokenId, value);

      const representationId = getWearableIdFromTokenURI(tokenURI);
      const contractAddress = contractAndTokenId.split("-")[0];
      const itemId = getItemId(contractAddress, representationId);

      itemIds.set(contractAddress, [
        ...(itemIds.get(contractAddress) || []),
        itemId,
      ]);
    });

    // ============ BENCHMARKING: DB Queries ============
    const dbQueryStart = Date.now();
    const {
      accounts,
      datas,
      parcels,
      estates,
      nfts,
      orders,
      wearables,
      ens,
      analytics,
      counts,
      bids,
      collections,
      items,
      metadatas,
    } = await getStoredData(ctx, {
      accountIds,
      landTokenIds,
      estateTokenIds,
      ensTokenIds,
      tokenIds,
      analyticsIds,
      bidIds,
      collectionIds,
      itemIds,
    });
    metrics.dbQueryTime = Date.now() - dbQueryStart;

    const sales = new Map<string, Sale>();

    // console.log(
    //   `about to get ${[...tokenIds.values()].reduce(
    //     (acc, curr) => acc + curr.length,
    //     0
    //   )} token URIs without filtering`
    // );

    // delete tokenIds from tokenIds array if they have been created and are in the nfts map
    // Array.from(tokenIds.entries()).forEach(([contractAddress, ids]) => {
    //   ids.forEach((tokenId) => {
    //     const nftId = getNFTId(
    //       contractAddress,
    //       tokenId.toString(),
    //       getCategory(Network.ETHEREUM, contractAddress)
    //     );
    //     if (nfts.has(nftId)) {
    //       const ids = tokenIds.get(contractAddress);
    //       if (ids) {
    //         const index = ids.indexOf(tokenId);
    //         if (index > -1) {
    //           ids.splice(index, 1);
    //         }
    //       }
    //     }
    //   });
    // });
    // console.log(
    //   `about to get ${[...tokenIds.values()].reduce(
    //     (acc, curr) => acc + curr.length,
    //     0
    //   )} non created token URIs`
    // );

    // if (tokenIds.size) {
    //   console.time("multicall tokenURIs");
    // }
    // const newTokenURIs =
    //   tokenIds.size > 0
    //     ? await tokenURIMutilcall(
    //         ctx,
    //         ctx.blocks[ctx.blocks.length - 1].header, // use latest block of the batch to multicall fetch
    //         tokenIds
    //       )
    //     : new Map<string, string>();

    // if (tokenIds.size) {
    //   console.timeEnd("multicall tokenURIs");
    // }

    // [...newTokenURIs.entries()].forEach(([contractAndTokenId, value]) => {
    //   tokenURIs.set(contractAndTokenId, value);
    // });

    // decode land token ids into coordinates for later usage
    if (landTokenIds.size > 0) {
      const newCoordinates = decodeTokenIdsToCoordinates(landTokenIds);

      newCoordinates.forEach((value, key) => {
        landCoordinates.set(key, value);
      });
    }

    // ============ BENCHMARKING: Event Processing ============
    const eventProcessingStart = Date.now();
    
    // markteplaceEvents Events
    for (const {
      block,
      event,
      topic,
      log,
      bidOwnerCutPerMillion,
      marketplaceOwnerCutPerMillion,
    } of markteplaceEvents) {
      if (topic === marketplaceAbi.events.OrderCreated.topic) {
        handleOrderCreated(
          event as marketplaceAbi.OrderCreatedEventArgs,
          block,
          log.address,
          log.transactionHash,
          orders,
          nfts,
          counts
        );
      } else if (topic === MarketplaceV3ABI.events.Traded.topic) {
        await handleTraded(
          ctx,
          event as MarketplaceV3ABI.TradedEventArgs,
          block,
          log.transactionHash,
          nfts,
          accounts,
          analytics,
          counts,
          sales
        );
      } else if (topic === marketplaceAbi.events.OrderSuccessful.topic) {
        await handleOrderSuccessful(
          ctx,
          event as marketplaceAbi.OrderSuccessfulEventArgs,
          block,
          log.transactionHash,
          marketplaceOwnerCutPerMillion || BigInt(0),
          orders,
          nfts,
          accounts,
          analytics,
          counts,
          sales
        );
      } else if (topic === marketplaceAbi.events.OrderCancelled.topic) {
        handleOrderCancelled(
          event as marketplaceAbi.OrderCancelledEventArgs,
          block,
          nfts,
          orders
        );
      } else if (topic === erc721Bid.events.BidCreated.topic) {
        handleBidCreated(
          event as erc721Bid.BidCreatedEventArgs,
          block,
          log.address,
          nfts,
          bids
        );
      } else if (topic === erc721Bid.events.BidAccepted.topic) {
        await handleBidAccepted(
          ctx,
          event as erc721Bid.BidAcceptedEventArgs,
          block,
          log.transactionHash,
          bidOwnerCutPerMillion || BigInt(0),
          bids,
          nfts,
          accounts,
          analytics,
          counts,
          sales
        );
      } else if (topic === erc721Bid.events.BidCancelled.topic && event) {
        handleBidCancelled(
          event as erc721Bid.BidCancelledEventArgs,
          block,
          bids,
          nfts
        );
      } else if (
        topic ===
          erc721abi.events["Transfer(address indexed,address indexed,uint256)"]
            .topic ||
        topic ===
          erc721abi.events[
            "Transfer(address indexed,address indexed,uint256 indexed,address,bytes)"
          ].topic ||
        topic ===
          erc721abi.events[
            "Transfer(address indexed,address indexed,uint256 indexed,address,bytes,bytes)"
          ].topic
      ) {
        if ([...Object.values(addresses.collections)].includes(log.address)) {
          handleTransferWearableV1(
            block.header,
            log.address,
            event as erc721abi.TransferEventArgs_2,
            collections,
            items,
            orders,
            accounts,
            metadatas,
            wearables,
            counts,
            mints,
            nfts,
            tokenURIs
          );
        } else {
          handleTransfer(
            block,
            log.address,
            event as erc721abi.TransferEventArgs_2,
            accounts,
            counts,
            nfts,
            parcels,
            estates,
            wearables,
            orders,
            ens,
            tokenURIs,
            landCoordinates
          );
        }
      } else if (topic === erc721abi.events.OwnershipTransferred.topic) {
        handleInitializeWearablesV1(counts);
      } else if (topic === erc721abi.events.AddWearable.topic) {
        await handleAddItemV1(
          ctx,
          log.address,
          event as erc721abi.AddWearableEventArgs,
          block,
          collections,
          items,
          counts,
          wearables,
          metadatas
        );
      } else if (
        topic === estateRegistryABI.events.CreateEstate.topic &&
        isCreateEstateEvent(event as estateRegistryABI.CreateEstateEventArgs)
      ) {
        handleCreateEstate(
          block,
          event as estateRegistryABI.CreateEstateEventArgs,
          nfts,
          estates,
          accounts,
          datas
        );
      } else if (
        topic === estateRegistryABI.events.Update.topic &&
        isUpdateEvent(event as estateRegistryABI.UpdateEventArgs)
      ) {
        handleEstateUpdate(
          event as estateRegistryABI.UpdateEventArgs,
          block,
          estates,
          nfts,
          datas
        );
      } else if (
        topic === estateRegistryABI.events.AddLand.topic &&
        isAddLandEvent(event as estateRegistryABI.AddLandEventArgs)
      ) {
        handleAddLand(
          event as estateRegistryABI.AddLandEventArgs,
          estates,
          nfts,
          parcels,
          accounts,
          landCoordinates
        );
      } else if (
        topic === estateRegistryABI.events.RemoveLand.topic &&
        isRemoveLandEvent(event as estateRegistryABI.RemoveLandEventArgs)
      ) {
        handleRemoveLand(
          event as estateRegistryABI.RemoveLandEventArgs,
          estates,
          nfts,
          parcels,
          accounts,
          landCoordinates
        );
      }
    }

    // Parcel events
    for (const { block, event, topic } of parcelEvents) {
      if (topic === landRegistryABI.events.Update.topic) {
        handleLandUpdate(event, block, parcels, nfts, landCoordinates, datas);
      }
    }

    // ENS Events
    for (const { block, event, topic, log } of ensEvents) {
      if (topic === dclRegistrarAbi.events.NameRegistered.topic) {
        let orderHash: string | undefined = undefined;

        // Search for OrderFilled event from Spoke in the same transaction
        for (let txLog of block.logs) {
          if (
            txLog.transactionIndex === log.transactionIndex &&
            txLog.topics[0] === SpokeABI.events.OrderFilled.topic &&
            txLog.address.toLowerCase() === addresses.Spoke?.toLowerCase()
          ) {
            // Decode the OrderFilled event to get the orderHash
            const orderFilledEvent = SpokeABI.events.OrderFilled.decode(txLog);
            orderHash = orderFilledEvent.orderHash;
            ctx.log.info(
              `Squid Router OrderFilled detected for ENS ${
                (event as dclRegistrarAbi.NameRegisteredEventArgs)._subdomain
              }: orderHash ${orderHash}`
            );
            break;
          }
        }

        handleNameRegistered(
          event as dclRegistrarAbi.NameRegisteredEventArgs,
          ens,
          nfts,
          accounts,
          orderHash
        );
      } else if (topic === dclControllerV2abi.events.NameBought.topic) {
        handleNameBought(
          event as dclControllerV2abi.NameBoughtEventArgs,
          BigInt(block.header.timestamp / 1000),
          analytics
        );
      }
    }

    metrics.eventProcessingTime = Date.now() - eventProcessingStart;

    try {
      // ============ BENCHMARKING: DB Upserts ============
      const upsertStart = Date.now();
      
      // ⚡ PHASE 1: Parallel upserts for independent entities (no FK dependencies)
      await Promise.all([
        ctx.store.upsert([...accounts.values()]),
        ctx.store.upsert([...datas.values()]),
        ctx.store.upsert([...estates.values()]),
        ctx.store.upsert([...parcels.values()]),
        ctx.store.upsert([...wearables.values()]),
        ctx.store.upsert([...ens.values()]),
        ctx.store.upsert([...analytics.values()]),
        ctx.store.upsert([...counts.values()]),
        ctx.store.upsert([...collections.values()]),
        ctx.store.upsert([...metadatas.values()]),
        ctx.store.upsert([...items.values()]),
      ]);

      // ⚡ PHASE 2: NFT <-> Order circular dependency workaround
      const orderByNFT: Map<string, Order> = new Map();
      for (const nft of nfts.values()) {
        if (nft.activeOrder) {
          orderByNFT.set(nft.id, nft.activeOrder);
          nft.activeOrder = null;
        }
      }
      await ctx.store.upsert([...nfts.values()]); // save NFTs with no orders (1st upsert)
      await ctx.store.upsert([...orders.values()]); // save orders

      // put NFT active orders back
      for (const [nftId, order] of orderByNFT) {
        const nft = nfts.get(nftId);
        if (nft) {
          nft.activeOrder = order;
        }
      }
      
      // ⚡ PHASE 3: Parallel - NFTs with orders + bids + sales + inserts
      await Promise.all([
        ctx.store.upsert([...nfts.values()]), // save NFTs back with orders (2nd upsert)
        ctx.store.upsert([...bids.values()]),
        ctx.store.upsert([...sales.values()]),
        ctx.store.insert([...transfers.values()]),
        ctx.store.insert([...mints.values()]),
      ]);

      metrics.upsertTime = Date.now() - upsertStart;

      // ============ BENCHMARKING: Total time and summary ============
      const totalTime = Date.now() - batchStartTime;
      
      // Check for slow operations (> 1s)
      const warnings: string[] = [];
      if (metrics.eventAccumulationTime > 1000) warnings.push(`Event Accum: ${metrics.eventAccumulationTime}ms`);
      if (metrics.dbQueryTime > 1000) warnings.push(`DB Queries: ${metrics.dbQueryTime}ms`);
      if (metrics.eventProcessingTime > 1000) warnings.push(`Event Proc: ${metrics.eventProcessingTime}ms`);
      if (metrics.upsertTime > 1000) warnings.push(`DB Upserts: ${metrics.upsertTime}ms`);
      if (totalTime > 5000) warnings.push(`Total: ${totalTime}ms`);
      
      const warningLine = warnings.length > 0 
        ? `\n⚠️  WARNING SLOW: ${warnings.join(' | ')}`
        : '';
      
      console.log(`
📊 ============ ETH BATCH METRICS ============
📦 Blocks: ${metrics.blockRange}
⏱️  Total Time: ${totalTime}ms
   ├─ Event Accumulation: ${metrics.eventAccumulationTime}ms (${((metrics.eventAccumulationTime/totalTime)*100).toFixed(1)}%)
   ├─ DB Queries: ${metrics.dbQueryTime}ms (${((metrics.dbQueryTime/totalTime)*100).toFixed(1)}%)
   ├─ Event Processing: ${metrics.eventProcessingTime}ms (${((metrics.eventProcessingTime/totalTime)*100).toFixed(1)}%)
   └─ DB Upserts: ${metrics.upsertTime}ms (${((metrics.upsertTime/totalTime)*100).toFixed(1)}%)
📈 Events Processed: ${metrics.eventsProcessed}
🔗 RPC Calls: ${metrics.rpcCalls}
💾 Entities: NFTs=${nfts.size}, Orders=${orders.size}, Accounts=${accounts.size}${warningLine}
==============================================
`);

      // log some stats
      ctx.log.info(
        `Batch from block: ${ctx.blocks[0].header.height} to ${
          ctx.blocks[ctx.blocks.length - 1].header.height
        } saved: parcels: ${parcels.size}, nfts: ${nfts.size}, accounts: ${
          accounts.size
        }, estates: ${estates.size}, transfers: ${transfers.size}, ens: ${
          ens.size
        }. Orders: ${orders.size}, Sales: ${sales.size}, Bids: ${bids.size}`
      );
    } catch (error) {
      ctx.log.error(`error: ${error}`);
    }
  }
);
