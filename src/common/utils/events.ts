import { Store } from '@subsquid/typeorm-store'
import { TransferReceivedEvent, Events } from '@dcl/schemas'
import { TransferEventArgs } from '../../polygon/abi/CollectionV2'
import { EntityManager } from 'typeorm'
import { NFT } from '../../model'
import eventPublisher from './event_publisher'

export async function getLastNotified(store: Store): Promise<bigint | null> {
  const em = (store as unknown as { em: () => EntityManager }).em()
  const result = await em.query(
    "SELECT last_notified FROM public.squids WHERE name = $1",
    ['marketplace']
  )
  if (!result || result.length === 0) {
    return null
  }
  const lastNotified = result[0]?.last_notified
  return lastNotified ? BigInt(lastNotified) : null
}

export async function setLastNotified(store: Store, timestamp: bigint) {
  const em = (store as unknown as { em: () => EntityManager }).em()
  await em.query(
    "UPDATE public.squids SET last_notified = $1 WHERE name = $2",
    [timestamp.toString(), 'marketplace']
  )
}

export async function sendTransferEvent(
  store: Store, 
  nft: NFT, 
  transferEvent: TransferEventArgs,
  lastNotified: bigint | null | undefined = undefined
) {
  try {
    // If lastNotified is undefined (not provided), fetch it from the database
    // This should only happen when processing new blocks (not historical)
    // If lastNotified is null, it means we're processing historical blocks and should skip
    if (lastNotified === undefined) {
      lastNotified = await getLastNotified(store)
      // Only log once per batch, not per NFT - this was causing spam
    }
    
    // If lastNotified is null (explicitly passed for historical blocks), skip sending event
    if (lastNotified === null) {
      // Skip silently - historical blocks don't need logging
      return
    }

    // Only send if there's no lastNotified timestamp or if the NFT was updated after the last notification
    if (lastNotified && nft.updatedAt <= lastNotified) {
      // Skip silently - no need to log each skipped NFT
      return
    }

    const event: TransferReceivedEvent = {
      type: Events.Type.BLOCKCHAIN,
      subType: Events.SubType.Blockchain.TRANSFER_RECEIVED,
      key: nft.id,
      timestamp: Number(nft.updatedAt.toString()),
      metadata: {
        senderAddress: transferEvent.from,
        receiverAddress: transferEvent.to,
        tokenUri: nft.tokenURI ?? undefined,
      }
    }
    await eventPublisher.publishMessage(event)
    
    // Update lastNotified timestamp after successfully sending the event
    await setLastNotified(store, nft.updatedAt)
    
    // Only log successful sends (these are rare in production)
    console.log(`[EVENTS] ✅ Sent transfer event for NFT ${nft.id}`)
  } catch (e) {
    console.log('[EVENTS] ❌ Error in sendTransferEvent:', e)
    console.log('[EVENTS] Could not send transfer event for NFT', nft.id)
  }
}
