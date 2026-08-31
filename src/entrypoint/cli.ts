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
import { createSlackOrchestratorIO } from "../orchestrator/slack-chat-io.js";
import { runManifoldLoop, type RunLoopDeps } from "./run-loop.js";
import { ConsoleNotifier } from "../notifier/console-notifier.js";
import { SlackNotifier } from "../notifier/slack-notifier.js";
import type { Notifier } from "../notifier/types.js";
import { StubVisualCapture } from "../visual-capture/stub-visual-capture.js";
import { createSlackApp, registerCheckpointHandler, connectSlackApp } from "../slack-resume-listener/real-slack-app.js";
import { RealSessionResumer } from "../session-resumer/real-session-resumer.js";
import { ensureTargetRepo } from "./ensure-repo.js";
import { SlackStatusBoard } from "../status-board/slack-status-board.js";
import { ConsoleStatusBoard } from "../status-board/console-status-board.js";
import type { RunStatusBoard } from "../status-board/types.js";

const execFile = promisify(execFileCb);

// The real, interactive entrypoint — meant to be run directly by a human in
// their own terminal (`npm run manifold -- "<feature description>" owner/repo`),
// not something driven by scripted input. Creates the target repo if it
// doesn't exist yet (module 1, step 1). When Slack is configured
// (SLACK_BOT_TOKEN/SLACK_APP_TOKEN/SLACK_CHANNEL_ID), plan negotiation,
// checkpoints, and PR notices all happen there instead of this terminal —
// otherwise everything falls back to this same terminal.
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

  const runnerDeps = { visualCapture: new StubVisualCapture() };
  const botToken = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;
  const channelId = process.env.SLACK_CHANNEL_ID;

  let orchestratorIO: { print: (text: string) => void; getHumanInput: () => Promise<string> };
  let notifier: Notifier;
  let statusBoard: RunStatusBoard;
  let checkpointAnswerFallback: RunLoopDeps["getCheckpointAnswer"];
  let stopSlack: (() => Promise<void>) | null = null;
  let rl: readline.Interface | null = null;

  if (botToken && appToken && channelId) {
    console.log("\n--- Slack is configured: plan negotiation, checkpoints, PR notices, and the status board all happen there now. ---\n");
    const { app, client } = createSlackApp(botToken, appToken);
    notifier = new SlackNotifier({ client, channelId });
    statusBoard = new SlackStatusBoard(client, channelId);
    const resumer = new RealSessionResumer({ ...runnerDeps, notifier });
    registerCheckpointHandler(app, { channelId, resolveDeps: { sessionResumer: resumer } });
    orchestratorIO = await createSlackOrchestratorIO(app, client, channelId, featureDescription);
    const connected = await connectSlackApp(app);
    stopSlack = connected.stop;
    console.log("Posted in Slack — go there to negotiate the plan.\n");
  } else {
    console.log("\n--- Slack isn't configured — negotiating the plan right here. ---\n");
    rl = readline.createInterface({ input: stdin, output: stdout });
    notifier = new ConsoleNotifier();
    statusBoard = new ConsoleStatusBoard();
    orchestratorIO = {
      print: (text) => console.log(`\n${text}`),
      getHumanInput: () => rl!.question("\n> "),
    };
    checkpointAnswerFallback = (question, options) =>
      rl!.question(`\n[checkpoint] ${question}${options?.length ? ` (${options.join(" / ")})` : ""}\n> `);
  }

  const plan = await runOrchestratorChat(featureDescription, { baseRepoPath, ...orchestratorIO });

  const { runId } = await materializeApprovedPlan({
    featureDescription,
    targetRepo,
    repoCreated,
    plan,
    worktreesRoot: path.join(workDir, "worktrees"),
  });

  console.log(`\nPlan approved (run ${runId}). Starting components. PRs open for real on GitHub — merge them there when ready.\n`);

  await runManifoldLoop(runId, {
    ...runnerDeps,
    notifier,
    statusBoard,
    baseRepoPath,
    targetRepo,
    baseBranch: "main",
    getCheckpointAnswer: checkpointAnswerFallback,
    print: (text) => console.log(text),
  });

  if (stopSlack) await stopSlack();
  if (rl) rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
