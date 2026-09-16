import * as OffChainMarketplaceABI from "../abi/DecentralandMarketplacePolygon";
import type { BlockData, Log } from "../processor";
import {
  setOffChainMarketplaceFeeCollector,
  setOffChainMarketplaceFeeRate,
  setOffChainMarketplaceRoyaltiesRate,
} from "../state";

export type FeeUpdateEventArgs =
  | OffChainMarketplaceABI.FeeCollectorUpdatedEventArgs
  | OffChainMarketplaceABI.FeeRateUpdatedEventArgs
  | OffChainMarketplaceABI.RoyaltiesRateUpdatedEventArgs;

/** One fee update, shaped for the batch's ordered event list. */
export type QueuedFeeUpdate = {
  topic: string;
  event: FeeUpdateEventArgs;
  block: BlockData;
  log: Log & { transactionHash: string };
};

const { FeeCollectorUpdated, FeeRateUpdated, RoyaltiesRateUpdated } =
  OffChainMarketplaceABI.events;

/**
 * Decodes a fee-update log into an entry for the batch's ordered event list, or null for any other
 * topic.
 *
 * Queued rather than applied on the spot: the batch's first pass sees every log before the second pass
 * handles any trade, so applying here would give every trade the batch's LAST configuration. Replayed
 * in log order by the second pass, a trade reads the configuration as of its own position.
 */
export function queueFeeUpdate(
  topic: string,
  log: QueuedFeeUpdate["log"],
  block: BlockData
): QueuedFeeUpdate | null {
  switch (topic) {
    case FeeCollectorUpdated.topic:
      return { topic, event: FeeCollectorUpdated.decode(log), block, log };
    case FeeRateUpdated.topic:
      return { topic, event: FeeRateUpdated.decode(log), block, log };
    case RoyaltiesRateUpdated.topic:
      return { topic, event: RoyaltiesRateUpdated.decode(log), block, log };
    default:
      return null;
  }
}

/** Applies a queued fee update to the emitting marketplace's cache; false for any other topic. */
export function applyFeeUpdate(
  topic: string,
  log: { address: string },
  event: FeeUpdateEventArgs
): boolean {
  switch (topic) {
    case FeeCollectorUpdated.topic:
      setOffChainMarketplaceFeeCollector(
        log.address,
        (event as OffChainMarketplaceABI.FeeCollectorUpdatedEventArgs)._feeCollector
      );
      return true;
    case FeeRateUpdated.topic:
      setOffChainMarketplaceFeeRate(
        log.address,
        (event as OffChainMarketplaceABI.FeeRateUpdatedEventArgs)._feeRate
      );
      return true;
    case RoyaltiesRateUpdated.topic:
      setOffChainMarketplaceRoyaltiesRate(
        log.address,
        (event as OffChainMarketplaceABI.RoyaltiesRateUpdatedEventArgs)._royaltiesRate
      );
      return true;
    default:
      return false;
  }
}
