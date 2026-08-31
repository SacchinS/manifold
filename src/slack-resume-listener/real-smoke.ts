import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { runs, components, checkpoints } from "../db/schema.js";
import { askHuman } from "../branch-agent/ask-human.js";
import { StubVisualCapture } from "../visual-capture/stub-visual-capture.js";
import { SlackNotifier } from "../notifier/slack-notifier.js";
import { createSlackApp, registerCheckpointHandler, connectSlackApp } from "./real-slack-app.js";
import { StubSessionResumer } from "../session-resumer/stub-session-resumer.js";

// Real proof of the last stubbed piece: an actual Slack post, received back
// through a real Socket Mode connection, resolving a real checkpoint. Uses
// a fake session_id and StubSessionResumer deliberately — the SDK resume
// mechanic is already proven elsewhere; this test isolates exactly what's
// new here, the Slack round-trip itself. This one genuinely needs a human:
// there's no way to simulate "someone replied in Slack" without an actual
// second identity posting the reply, so it waits for a real one.
async function main() {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;
  const channelId = process.env.SLACK_CHANNEL_ID;
  if (!botToken || !appToken || !channelId) {
    throw new Error("SLACK_BOT_TOKEN, SLACK_APP_TOKEN, and SLACK_CHANNEL_ID must all be set in .env");
  }

  const resumer = new StubSessionResumer();
  const { app, client } = createSlackApp(botToken, appToken);
  const notifier = new SlackNotifier({ client, channelId });
  registerCheckpointHandler(app, { channelId, resolveDeps: { sessionResumer: resumer } });
  const { stop } = await connectSlackApp(app);

  const [run] = await db
    .insert(runs)
    .values({ featureDescription: "real slack smoke test", targetRepo: "sacchin/example-app", repoCreated: false, plan: {} })
    .returning();

  const [component] = await db
    .insert(components)
    .values({
      runId: run.id,
      branchName: "component/slack-smoke",
      worktreePath: "/tmp/does-not-matter-for-this-test",
      taskDescription: "slack integration smoke test",
      ownedPaths: [],
      dependsOn: [],
      status: "in_progress",
      sessionId: "fake-session-for-slack-smoke-test",
    })
    .returning();

  console.log("=== posting a real checkpoint to Slack ===");
  const result = await askHuman(
    {
      componentId: component.id,
      worktreePath: component.worktreePath,
      question: "Manifold Slack integration test — reply anything in this thread to confirm the resume path works end to end.",
      options: ["Looks good"],
    },
    { notifier, visualCapture: new StubVisualCapture() },
  );

  console.log(`\nPosted. >>> Go reply to that message in the Slack thread now. <<<`);
  console.log("Waiting up to 5 minutes for a real reply...\n");

  const deadline = Date.now() + 5 * 60_000;
  let resolved = false;
  while (Date.now() < deadline) {
    const [checkpoint] = await db.select().from(checkpoints).where(eq(checkpoints.id, result.checkpointId));
    if (checkpoint.status === "resolved") {
      resolved = true;
      console.log("checkpoint resolved via a real Slack reply? true");
      console.log("answer received:", JSON.stringify(checkpoint.answer));
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  if (!resolved) console.log("checkpoint resolved via a real Slack reply? false (timed out)");

  const [componentAfter] = await db.select().from(components).where(eq(components.id, component.id));
  console.log("component back to in_progress after resume?", componentAfter.status === "in_progress");

  await stop();
  console.log(resolved ? "\nreal Slack integration smoke test passed." : "\nreal Slack integration smoke test timed out.");
  process.exit(resolved ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
