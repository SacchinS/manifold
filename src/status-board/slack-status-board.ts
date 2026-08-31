import type { WebClient } from "@slack/web-api";
import { renderStatusText } from "./render.js";
import type { ComponentStatusSummary, RunStatusBoard } from "./types.js";

export class SlackStatusBoard implements RunStatusBoard {
  private messageTs: string | undefined;
  private lastRendered: string | undefined;

  constructor(
    private readonly client: WebClient,
    private readonly channelId: string,
  ) {}

  async update(runId: number, components: ComponentStatusSummary[]): Promise<void> {
    const text = renderStatusText(runId, components);
    if (text === this.lastRendered) return; // no-op if nothing actually changed since last render
    this.lastRendered = text;

    if (!this.messageTs) {
      const result = await this.client.chat.postMessage({ channel: this.channelId, text });
      this.messageTs = result.ts;
    } else {
      await this.client.chat.update({ channel: this.channelId, ts: this.messageTs, text });
    }
  }
}
