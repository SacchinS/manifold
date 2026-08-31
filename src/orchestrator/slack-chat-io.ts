import type { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import type { OrchestratorChatDeps } from "./chat-loop.js";

// Lets module 1's plan negotiation happen entirely in Slack instead of the
// terminal — chat-loop.ts doesn't know or care which one it's talking to,
// since print/getHumanInput are already pluggable. Posts one root message
// to start a thread, then every further orchestrator turn threads onto it;
// getHumanInput resolves on the next reply in that same thread. This is a
// live, synchronous wait the whole time (same as the terminal version) —
// no checkpoint row, no DB state, matching module 1's reasoning that the
// human is present for this part regardless of which surface it happens on.
export async function createSlackOrchestratorIO(
  app: App,
  client: WebClient,
  channelId: string,
  featureDescription: string,
): Promise<Pick<OrchestratorChatDeps, "print" | "getHumanInput">> {
  let threadTs: string | undefined;
  let pendingResolve: ((text: string) => void) | null = null;

  app.message(async ({ message }) => {
    if (message.subtype === "bot_message" || "bot_id" in message) return;
    if (message.channel !== channelId) return;
    if (!threadTs) return;
    if (!("thread_ts" in message) || message.thread_ts !== threadTs) return;
    if (!("text" in message) || !message.text) return;
    if (pendingResolve) {
      const resolve = pendingResolve;
      pendingResolve = null;
      resolve(message.text);
    }
  });

  const initial = await client.chat.postMessage({
    channel: channelId,
    text: `*Negotiating a plan:* ${featureDescription}\n_Inspecting the repo — the first response can take a few minutes._`,
  });
  threadTs = initial.ts;

  return {
    print: (text: string) => {
      client.chat.postMessage({ channel: channelId, text, thread_ts: threadTs }).catch((err) => {
        console.error("[slack orchestrator] failed to post:", err);
      });
    },
    getHumanInput: () =>
      new Promise<string>((resolve) => {
        pendingResolve = resolve;
      }),
  };
}
