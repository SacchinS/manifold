import "dotenv/config";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { runOrchestratorChat } from "../orchestrator/chat-loop.js";
import { materializeApprovedPlan } from "../orchestrator/materialize-plan.js";
import { runManifoldLoop, type RunLoopDeps } from "./run-loop.js";
import { ConsoleNotifier } from "../notifier/console-notifier.js";
import { SlackNotifier } from "../notifier/slack-notifier.js";
import { StubVisualCapture } from "../visual-capture/stub-visual-capture.js";
import { createSlackApp, startSlackListener } from "../slack-resume-listener/real-slack-app.js";
import { RealSessionResumer } from "../session-resumer/real-session-resumer.js";
import { ensureTargetRepo } from "./ensure-repo.js";

const execFile = promisify(execFileCb);

// The real, interactive entrypoint — meant to be run directly by a human in
// their own terminal (`npm run manifold -- "<feature description>" owner/repo`),
// not something driven by scripted input. Creates the target repo if it
// doesn't exist yet (module 1, step 1). Plan negotiation always happens
// right here in the terminal (module 1 — the human is live and present for
// that regardless of Slack). Checkpoint answering goes through real Slack
// when SLACK_BOT_TOKEN/SLACK_APP_TOKEN/SLACK_CHANNEL_ID are set, falling
// back to this same terminal otherwise.
async function main() {
  const featureDescription = process.argv[2];
  const targetRepo = process.argv[3];

  if (!featureDescription || !targetRepo) {
    console.error('Usage: npm run manifold -- "<feature description>" <owner/repo>');
    process.exit(1);
  }

  const { repoCreated } = await ensureTargetRepo(targetRepo);

  const workDir = path.join(homedir(), ".manifold", "runs", `${Date.now()}`);
  const baseRepoPath = path.join(workDir, "repo");
  await mkdir(workDir, { recursive: true });

  console.log(`Cloning ${targetRepo}...`);
  await execFile("gh", ["repo", "clone", targetRepo, baseRepoPath]);

  const rl = readline.createInterface({ input: stdin, output: stdout });

  console.log("\n--- Negotiating a plan with the orchestrator ---\n");
  const plan = await runOrchestratorChat(featureDescription, {
    baseRepoPath,
    print: (text) => console.log(`\n${text}`),
    getHumanInput: () => rl.question("\n> "),
  });

  const { runId } = await materializeApprovedPlan({
    featureDescription,
    targetRepo,
    repoCreated,
    plan,
    worktreesRoot: path.join(workDir, "worktrees"),
  });

  const runnerDeps = { visualCapture: new StubVisualCapture() };

  const { botToken, appToken, channelId } = {
    botToken: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    channelId: process.env.SLACK_CHANNEL_ID,
  };

  let loopDeps: RunLoopDeps;
  let stopSlack: (() => Promise<void>) | null = null;

  if (botToken && appToken && channelId) {
    console.log(`\n--- Plan approved (run ${runId}). Checkpoints and PR notices will post to Slack. ---\n`);
    const { app, client } = createSlackApp(botToken, appToken);
    const notifier = new SlackNotifier({ client, channelId });
    const resumer = new RealSessionResumer({ ...runnerDeps, notifier });
    const listener = await startSlackListener(app, { channelId, resolveDeps: { sessionResumer: resumer } });
    stopSlack = listener.stop;
    loopDeps = {
      ...runnerDeps,
      notifier,
      baseRepoPath,
      targetRepo,
      baseBranch: "main",
      print: (text) => console.log(text),
    };
  } else {
    console.log(`\n--- Plan approved (run ${runId}). Slack isn't configured — checkpoints will be asked right here. ---\n`);
    loopDeps = {
      ...runnerDeps,
      notifier: new ConsoleNotifier(),
      baseRepoPath,
      targetRepo,
      baseBranch: "main",
      getCheckpointAnswer: (question, options) =>
        rl.question(`\n[checkpoint] ${question}${options?.length ? ` (${options.join(" / ")})` : ""}\n> `),
      print: (text) => console.log(text),
    };
  }

  console.log("PRs open for real on GitHub — merge them there when ready.\n");

  await runManifoldLoop(runId, loopDeps);

  if (stopSlack) await stopSlack();
  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
