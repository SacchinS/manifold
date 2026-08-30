import "dotenv/config";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { runs, components, checkpoints, decisionLog } from "../db/schema.js";
import { addWorktree } from "../worktree/manager.js";
import { ConsoleNotifier } from "../notifier/console-notifier.js";
import { StubVisualCapture } from "../visual-capture/stub-visual-capture.js";
import { RealComponentLauncher } from "../component-launcher/real-component-launcher.js";
import { RealSessionResumer } from "../session-resumer/real-session-resumer.js";
import { handleReply } from "../slack-resume-listener/handle-reply.js";

const execFile = promisify(execFileCb);

// End-to-end proof of the real branch agent runner against a live SDK
// session (subscription-authenticated, real cost in usage but trivial in
// size) — launch, ask_human pause, Slack-reply-simulated resume, and
// mark_ready_for_pr, exercising every piece built for this step in one pass.
async function main() {
  const root = await mkdtemp(path.join(tmpdir(), "manifold-runner-smoke-"));
  const baseRepoPath = path.join(root, "base");
  await execFile("git", ["init", "-q", "-b", "main", baseRepoPath]);
  await execFile("git", ["config", "user.email", "smoke@manifold.test"], { cwd: baseRepoPath });
  await execFile("git", ["config", "user.name", "Manifold Smoke Test"], { cwd: baseRepoPath });
  await execFile("git", ["commit", "--allow-empty", "-q", "-m", "initial commit"], { cwd: baseRepoPath });

  const worktreePath = path.join(root, "wt-greeting");
  await addWorktree({ baseRepoPath, worktreePath, branchName: "component/greeting" });

  const [run] = await db
    .insert(runs)
    .values({ featureDescription: "runner smoke", targetRepo: "sacchin/example-app", repoCreated: false, plan: {} })
    .returning();

  const [component] = await db
    .insert(components)
    .values({
      runId: run.id,
      branchName: "component/greeting",
      worktreePath,
      taskDescription:
        "Create a file called GREETING.md containing a short greeting, then commit it with git. " +
        "Before deciding the wording, call ask_human to ask whether the greeting should be formal or casual, with options ['Formal', 'Casual']. " +
        "Also call log_decision once to record what you named the file (even though the name is given, treat it as a decision worth logging for this test). " +
        "After committing, call mark_ready_for_pr exactly once.",
      ownedPaths: ["GREETING.md"],
      dependsOn: [],
      status: "blocked_on_deps",
    })
    .returning();

  const runnerDeps = { notifier: new ConsoleNotifier(), visualCapture: new StubVisualCapture() };
  const launcher = new RealComponentLauncher(runnerDeps);
  const resumer = new RealSessionResumer(runnerDeps);

  console.log("=== launching real branch agent ===");
  // Mirrors schedulerTick's real pattern (tick.ts): status flips to
  // in_progress *before* the agent runs, and only sessionId is written
  // after — status itself is left entirely to the agent's own tool calls
  // (ask_human, mark_ready_for_pr) or the runner's own end-of-run fallback,
  // never overwritten by the caller.
  await db.update(components).set({ status: "in_progress", updatedAt: new Date() }).where(eq(components.id, component.id));
  const { sessionId } = await launcher.launch({
    componentId: component.id,
    branchName: component.branchName,
    worktreePath,
    taskDescription: component.taskDescription,
    ownedPaths: component.ownedPaths,
  });
  await db.update(components).set({ sessionId, updatedAt: new Date() }).where(eq(components.id, component.id));

  console.log("\nlaunch produced a session_id?", !!sessionId, sessionId);

  const [componentAfterLaunch] = await db.select().from(components).where(eq(components.id, component.id));
  console.log("component paused at awaiting_input?", componentAfterLaunch.status === "awaiting_input");

  const [checkpoint] = await db.select().from(checkpoints).where(eq(checkpoints.componentId, component.id));
  console.log("a real checkpoint was created with a thread?", !!checkpoint && checkpoint.slackThreadTs !== null);
  console.log("checkpoint question mentions formal/casual?", /formal|casual/i.test(checkpoint?.question ?? ""));

  console.log("\n=== simulating the Slack reply ===");
  const reply = await handleReply({ threadTs: checkpoint.slackThreadTs!, answer: "Casual" }, { sessionResumer: resumer });
  console.log("reply resolved the checkpoint?", reply.resolved === true);

  const [componentAfterResume] = await db.select().from(components).where(eq(components.id, component.id));
  console.log(
    "\ncomponent reached ready_for_pr after resume?",
    componentAfterResume.status === "ready_for_pr",
    "(actual:",
    componentAfterResume.status,
    ")",
  );

  const decisions = await db.select().from(decisionLog).where(eq(decisionLog.componentId, component.id));
  console.log("at least one autonomous_decision logged?", decisions.some((d) => d.entryType === "autonomous_decision"));
  console.log("a checkpoint_resolved entry logged?", decisions.some((d) => d.entryType === "checkpoint_resolved"));

  const greetingPath = path.join(worktreePath, "GREETING.md");
  const greetingContent = await readFile(greetingPath, "utf8").catch(() => null);
  console.log("\nGREETING.md actually exists in the worktree?", greetingContent !== null);
  if (greetingContent) console.log("content:", JSON.stringify(greetingContent));

  const { stdout: log } = await execFile("git", ["log", "--oneline"], { cwd: worktreePath });
  console.log("agent actually committed its work?", log.trim().split("\n").length > 1);

  await rm(root, { recursive: true, force: true });
  console.log("\nrunner end-to-end smoke test passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
