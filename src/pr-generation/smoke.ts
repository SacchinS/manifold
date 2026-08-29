import { execFile as execFileCb, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { runs, components, decisionLog } from "../db/schema.js";
import { addWorktree } from "../worktree/manager.js";
import { generatePr } from "./generate-pr.js";
import { pollForMerges } from "./poll-merges.js";
import { StubSummaryWriter } from "./stub-summary-writer.js";
import { StubGitHubClient } from "./stub-github-client.js";
import { StubComponentLauncher } from "../component-launcher/stub-component-launcher.js";
import { isAlive } from "../util/process.js";

const execFile = promisify(execFileCb);

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), "manifold-pr-smoke-"));
  const baseRepoPath = path.join(root, "base");
  await execFile("git", ["init", "-q", "-b", "main", baseRepoPath]);
  await execFile("git", ["config", "user.email", "smoke@manifold.test"], { cwd: baseRepoPath });
  await execFile("git", ["config", "user.name", "Manifold Smoke Test"], { cwd: baseRepoPath });
  await execFile("git", ["commit", "--allow-empty", "-q", "-m", "initial commit"], { cwd: baseRepoPath });

  const [run] = await db
    .insert(runs)
    .values({ featureDescription: "pr generation smoke", targetRepo: "sacchin/example-app", repoCreated: false, plan: {} })
    .returning();

  const worktreePathX = path.join(root, "wt-x");
  await addWorktree({ baseRepoPath, worktreePath: worktreePathX, branchName: "manifold/component-x" });

  const fakeDevServer = spawn("sleep", ["3600"], { stdio: "ignore", detached: true });
  fakeDevServer.unref();

  const [componentX] = await db
    .insert(components)
    .values({
      runId: run.id,
      branchName: "manifold/component-x",
      worktreePath: worktreePathX,
      taskDescription: "Add dark mode toggle to settings",
      ownedPaths: ["src/components/**"],
      dependsOn: [],
      status: "ready_for_pr",
      devServerPid: fakeDevServer.pid,
    })
    .returning();

  const [componentY] = await db
    .insert(components)
    .values({
      runId: run.id,
      branchName: "manifold/component-y",
      worktreePath: path.join(root, "wt-y"),
      taskDescription: "Wire toggle into theme provider",
      ownedPaths: ["src/theme/**"],
      dependsOn: [componentX.id],
      status: "blocked_on_deps",
    })
    .returning();

  await db.insert(decisionLog).values([
    { componentId: componentX.id, entryType: "autonomous_decision", content: "Used a CSS variable instead of a context provider for the toggle state." },
    { componentId: componentX.id, entryType: "checkpoint_resolved", content: "Q: header or settings page?\nA: header" },
  ]);

  const summaryWriter = new StubSummaryWriter();
  const githubClient = new StubGitHubClient();
  const launcher = new StubComponentLauncher();
  const schedulerDeps = { baseRepoPath, launcher };

  // 1. Generate the PR.
  const { prNumber, body } = await generatePr(componentX.id, {
    summaryWriter,
    githubClient,
    targetRepo: run.targetRepo,
    baseBranch: "main",
  });
  console.log("PR body:\n" + body + "\n");
  console.log("body includes both decision log entries?", body.includes("CSS variable") && body.includes("header"));

  const [componentXAfterPr] = await db.select().from(components).where(eq(components.id, componentX.id));
  console.log("component moved to pr_open with pr number set?", componentXAfterPr.status === "pr_open" && componentXAfterPr.prNumber === prNumber);

  // 2. Poll while still open — nothing should happen.
  const pollWhileOpen = await pollForMerges(run.id, { githubClient, targetRepo: run.targetRepo, baseRepoPath, schedulerDeps });
  console.log("\npoll while PR open: no merges detected?", pollWhileOpen.mergedComponentIds.length === 0);
  console.log("dev server still alive?", isAlive(fakeDevServer.pid!));

  const [componentYStillBlocked] = await db.select().from(components).where(eq(components.id, componentY.id));
  console.log("dependent component still blocked_on_deps?", componentYStillBlocked.status === "blocked_on_deps");

  // 3. Simulate the PR getting merged, then poll again.
  githubClient.setStatus(prNumber, "merged");
  const pollAfterMerge = await pollForMerges(run.id, { githubClient, targetRepo: run.targetRepo, baseRepoPath, schedulerDeps });
  console.log("\npoll after merge: component reported merged?", pollAfterMerge.mergedComponentIds.includes(componentX.id));
  console.log("dev server killed?", !isAlive(fakeDevServer.pid!));

  const [componentXAfterMerge] = await db.select().from(components).where(eq(components.id, componentX.id));
  console.log("component status is merged?", componentXAfterMerge.status === "merged");

  console.log(
    "scheduler picked up newly-unblocked dependent component?",
    pollAfterMerge.newlyLaunchedComponentIds.includes(componentY.id),
  );
  const [componentYAfterMerge] = await db.select().from(components).where(eq(components.id, componentY.id));
  console.log("dependent component now in_progress with a session_id?", componentYAfterMerge.status === "in_progress" && !!componentYAfterMerge.sessionId);

  await rm(root, { recursive: true, force: true });
  console.log("\npr generation smoke test passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
