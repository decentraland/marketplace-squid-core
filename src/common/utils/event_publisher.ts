/* eslint-disable @typescript-eslint/naming-convention */
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns'
import { Event } from '@dcl/schemas'

class EventPublisher {
  snsArn = process.env.AWS_SNS_ARN
  endpoint = process.env.AWS_SNS_ENDPOINT
  client = new SNSClient({ endpoint: this.endpoint })

  async publishMessage(event: Event): Promise<string | undefined> {
    console.log('[event_publisher] Publishing message:', event)
    const { MessageId } = await this.client.send(
      new PublishCommand({
        TopicArn: this.snsArn,
        Message: JSON.stringify(event),
        MessageAttributes: {
          type: {
            DataType: 'String',
            StringValue: event.type
          },
          subType: {
            DataType: 'String',
            StringValue: event.subType
          }
        }
      })
    )

    return MessageId
  }
}

export default new EventPublisher()
