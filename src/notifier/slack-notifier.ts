import type { WebClient } from "@slack/web-api";
import type { Notifier, PostCheckpointInput, PostCheckpointResult, PostWarningInput } from "./types.js";

export interface SlackNotifierOptions {
  client: WebClient;
  channelId: string;
}

// Real Slack implementation, module 3 in manifold-handoff.md. Screenshot
// upload is a deliberate TODO: visual capture (module 4) still writes a
// placeholder text file, not a real image, so there's nothing genuine to
// upload yet regardless of is_visual — this just posts the question/options
// as text for now. Options render as plain text rather than Block Kit
// buttons; any text reply in the thread already resolves a checkpoint
// (module 5), so buttons are a UX nicety to add later, not a requirement.
export class SlackNotifier implements Notifier {
  constructor(private readonly options: SlackNotifierOptions) {}

  async postCheckpoint(input: PostCheckpointInput): Promise<PostCheckpointResult> {
    const lines = [`*Component ${input.componentId}*`, input.question];
    if (input.options?.length) lines.push(`Options: ${input.options.join(" | ")}`);

    const result = await this.options.client.chat.postMessage({
      channel: this.options.channelId,
      text: lines.join("\n"),
    });

    if (!result.ok || !result.ts) {
      throw new Error(`Slack chat.postMessage failed: ${result.error ?? "unknown error"}`);
    }

    return { slackThreadTs: result.ts, slackChannel: this.options.channelId };
  }

  async postWarning(input: PostWarningInput): Promise<void> {
    const result = await this.options.client.chat.postMessage({
      channel: this.options.channelId,
      text: `:warning: ${input.message}`,
    });
    if (!result.ok) {
      throw new Error(`Slack chat.postMessage failed: ${result.error ?? "unknown error"}`);
    }
  }
}
