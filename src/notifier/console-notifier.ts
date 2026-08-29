import type { Notifier, PostCheckpointInput, PostCheckpointResult } from "./types.js";

// Stub stand-in for the Slack notifier. Logs what would have been posted and
// fabricates a thread_ts/channel so the rest of the checkpoint flow (module 4)
// can be built and tested before Slack is wired up.
export class ConsoleNotifier implements Notifier {
  async postCheckpoint(input: PostCheckpointInput): Promise<PostCheckpointResult> {
    console.log(`\n[stub-slack] checkpoint for component ${input.componentId}`);
    console.log(`[stub-slack] Q: ${input.question}`);
    if (input.options?.length) {
      console.log(`[stub-slack] options: ${input.options.join(" | ")}`);
    }
    if (input.screenshotPath) {
      console.log(`[stub-slack] screenshot: ${input.screenshotPath}`);
    }
    const slackThreadTs = `stub-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    console.log(`[stub-slack] posted, thread_ts=${slackThreadTs}\n`);
    return { slackThreadTs, slackChannel: "#stub-channel" };
  }
}
