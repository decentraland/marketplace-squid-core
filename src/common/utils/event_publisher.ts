/* eslint-disable @typescript-eslint/naming-convention */
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns'
import { Event } from '@dcl/schemas'

class EventPublisher {
  snsArn = process.env.AWS_SNS_ARN
  endpoint = process.env.AWS_SNS_ENDPOINT
  private _client: SNSClient | null = null

  private getClient(): SNSClient {
    if (!this._client) {
      this._client = new SNSClient({ endpoint: this.endpoint })
    }
    return this._client
  }

  async publishMessage(event: Event): Promise<string | undefined> {
    if (!this.snsArn) {
      throw new Error('AWS_SNS_ARN environment variable is not set. Cannot publish message.')
    }

    console.log('[event_publisher] Publishing message:', event)
    const { MessageId } = await this.getClient().send(
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
