import { App } from "@slack/bolt";

export interface SlackMessageResponse {
  ok: boolean;
  ts?: string;
  channel?: string;
}

export interface ISlackComponent {
  sendMessage(channel: string, message: string): Promise<SlackMessageResponse>;
}

// Minimal Slack client built on @slack/bolt, mirroring the pattern used by
// credits-squid-core. Used to post indexing/ops alerts to the squid-alerts channel.
export function createSlackComponent(config: {
  botToken: string;
  signingSecret: string;
}): ISlackComponent {
  const app = new App({
    token: config.botToken,
    signingSecret: config.signingSecret,
  });

  async function sendMessage(
    channel: string,
    message: string
  ): Promise<SlackMessageResponse> {
    const result = await app.client.chat.postMessage({ channel, text: message });
    return { ok: result.ok ?? false, ts: result.ts, channel: result.channel };
  }

  return { sendMessage };
}
