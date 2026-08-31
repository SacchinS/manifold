import { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { handleReply } from "./handle-reply.js";
import type { ResolveCheckpointDeps } from "../checkpoints/resolve.js";

// Split into two phases deliberately, to break a real circular dependency:
// the listener needs a SessionResumer, which needs a Notifier (in case the
// resumed run asks another question), which needs this app's WebClient —
// but the client exists as soon as the App is constructed, well before
// .start() opens the actual socket connection.

export function createSlackApp(botToken: string, appToken: string): { app: App; client: WebClient } {
  const app = new App({ token: botToken, appToken, socketMode: true });
  return { app, client: app.client };
}

export interface StartSlackListenerOptions {
  channelId: string;
  resolveDeps: ResolveCheckpointDeps;
}

// Module 5 in manifold-handoff.md, for real. Socket Mode means no public
// endpoint is needed, matching the design's reasoning for choosing it over
// the Events API's HTTP delivery. Reuses handleReply (module 5's actual
// resolve logic, already proven against stubs) completely unchanged — this
// file is purely the Slack-specific wiring that was stubbed out until now.
export async function startSlackListener(app: App, options: StartSlackListenerOptions): Promise<{ stop: () => Promise<void> }> {
  app.message(async ({ message }) => {
    // Ignore the bot's own posts (checkpoints, warnings) — without this,
    // every message this app posts would loop back through this same
    // handler. Only a threaded reply can resolve anything; a top-level
    // message in the channel isn't a reply to any specific checkpoint.
    if (message.subtype === "bot_message" || "bot_id" in message) return;
    if (message.channel !== options.channelId) return;
    if (!("thread_ts" in message) || !message.thread_ts) return;
    if (!("text" in message) || !message.text) return;

    const result = await handleReply({ threadTs: message.thread_ts, answer: message.text }, options.resolveDeps);
    if (!result.resolved) {
      console.log(
        `[slack] reply in thread ${message.thread_ts} resolved nothing (already resolved, or no matching checkpoint)`,
      );
    }
  });

  await app.start();
  console.log("[slack] connected via Socket Mode");

  return {
    stop: async () => {
      await app.stop();
    },
  };
}
