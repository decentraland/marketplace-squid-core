import { Store } from '@subsquid/typeorm-store'
import { TransferReceivedEvent, Events } from '@dcl/schemas'
import { EntityManager } from 'typeorm'
import { Category, NFT } from '../../model'
import eventPublisher from './event_publisher'

export async function getLastNotified(store: Store): Promise<bigint | null> {
  const em = (store as unknown as { em: () => EntityManager }).em()
  const lastNotified = (await em.query("SELECT last_notified FROM public.squids WHERE name = 'marketplace'"))[0].last_notified
  return lastNotified && BigInt(lastNotified)
}

export async function setLastNotified(store: Store, timestamp: bigint) {
  const em = (store as unknown as { em: () => EntityManager }).em()
  await em.query(`UPDATE public.squids SET last_notified = ${timestamp} WHERE name = 'marketplace'`)
}

export async function sendEvents(store: Store, modifiedNFTs: NFT[], timestamp: bigint) {
  try {
    const lastNotified = await getLastNotified(store)
    const events = (
      await Promise.all(
        modifiedNFTs
          .filter(nft => !lastNotified || nft.updatedAt > lastNotified)
          .map(async nft => {
            const event: TransferReceivedEvent = {
              type: Events.Type.BLOCKCHAIN,
              subType: Events.SubType.Blockchain.TRANSFER_RECEIVED,
              key: nft.id,
              timestamp: Number(nft.updatedAt.toString()),
              metadata: {
                senderAddress: nft.ownerAddress ?? undefined,
                receiverAddress: nft.ownerAddress ?? undefined,
                rarity:
                  nft.category === Category.wearable
                    ? nft.searchWearableRarity ?? undefined
                    : nft.searchEmoteRarity ?? undefined,
                image: nft.image ?? undefined
              }
            }
            return event
          })
      )
    )

    await Promise.all(events.map(event => eventPublisher.publishMessage(event)))
  } catch (e) {
    console.log('Error in sendEvents:', e)
    console.log(
      'Could not send events for NFTs with id',
      modifiedNFTs.map(nft => nft.id)
    )
  }
}
