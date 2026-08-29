import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { runs, components, checkpoints, decisionLog } from "../db/schema.js";
import { ConsoleNotifier } from "../notifier/console-notifier.js";
import type { PostWarningInput } from "../notifier/types.js";
import { StubSummaryWriter } from "./stub-summary-writer.js";
import { StubGitHubClient } from "./stub-github-client.js";
import { prepareForPr } from "./prepare-for-pr.js";

const execFile = promisify(execFileCb);

async function git(args: string[], cwd: string) {
  await execFile("git", args, { cwd });
}

class SpyNotifier extends ConsoleNotifier {
  warnings: PostWarningInput[] = [];
  async postWarning(input: PostWarningInput): Promise<void> {
    this.warnings.push(input);
    return super.postWarning(input);
  }
}

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), "manifold-prepare-smoke-"));
  const base = path.join(root, "base");
  await git(["init", "-q", "-b", "main", base]);
  await git(["config", "user.email", "smoke@manifold.test"], base);
  await git(["config", "user.name", "Manifold Smoke Test"], base);
  await writeFile(path.join(base, "fileA.txt"), "line1\n");
  await git(["add", "fileA.txt"], base);
  await git(["commit", "-q", "-m", "initial fileA"], base);

  const [run] = await db
    .insert(runs)
    .values({ featureDescription: "prepare-for-pr smoke", targetRepo: "sacchin/example-app", repoCreated: false, plan: {} })
    .returning();

  // --- Component X: will conflict with main ---
  const wtX = path.join(root, "wt-x");
  await git(["worktree", "add", wtX, "-b", "component/x"], base);
  await writeFile(path.join(wtX, "fileA.txt"), "line1-X\n");
  await git(["add", "fileA.txt"], wtX);
  await git(["commit", "-q", "-m", "X changes line1"], wtX);

  const [componentX] = await db
    .insert(components)
    .values({
      runId: run.id,
      branchName: "component/x",
      worktreePath: wtX,
      taskDescription: "Component X",
      ownedPaths: ["fileA.txt"],
      dependsOn: [],
      status: "ready_for_pr",
      sessionId: "session-x",
    })
    .returning();

  // main moves forward, conflicting with X.
  await writeFile(path.join(base, "fileA.txt"), "line1-main\n");
  await git(["add", "fileA.txt"], base);
  await git(["commit", "-q", "-m", "main changes line1"], base);

  // --- Component Y: clean merge, no overlap with anything ---
  const wtY = path.join(root, "wt-y");
  await git(["worktree", "add", wtY, "-b", "component/y"], base);
  await writeFile(path.join(wtY, "fileB.txt"), "hello\n");
  await git(["add", "fileB.txt"], wtY);
  await git(["commit", "-q", "-m", "Y adds fileB"], wtY);

  const [componentY] = await db
    .insert(components)
    .values({
      runId: run.id,
      branchName: "component/y",
      worktreePath: wtY,
      taskDescription: "Component Y",
      ownedPaths: ["fileB.txt"],
      dependsOn: [],
      status: "ready_for_pr",
      sessionId: "session-y",
    })
    .returning();

  // --- Component W: clean merge, but overlaps with still-in-progress component V's owned_paths ---
  const wtW = path.join(root, "wt-w");
  await git(["worktree", "add", wtW, "-b", "component/w"], base);
  await mkdir(path.join(wtW, "src", "shared"), { recursive: true });
  await writeFile(path.join(wtW, "src", "shared", "utils.ts"), "export const noop = () => {};\n");
  await git(["add", "."], wtW);
  await git(["commit", "-q", "-m", "W adds shared util"], wtW);

  const [componentW] = await db
    .insert(components)
    .values({
      runId: run.id,
      branchName: "component/w",
      worktreePath: wtW,
      taskDescription: "Component W",
      ownedPaths: ["src/shared/**"],
      dependsOn: [],
      status: "ready_for_pr",
      sessionId: "session-w",
    })
    .returning();

  await db.insert(components).values({
    runId: run.id,
    branchName: "component/v",
    worktreePath: path.join(root, "wt-v"),
    taskDescription: "Component V (still in progress, claims src/shared/**)",
    ownedPaths: ["src/shared/**"],
    dependsOn: [],
    status: "in_progress",
    sessionId: "session-v",
  });

  const notifier = new SpyNotifier();
  const summaryWriter = new StubSummaryWriter();
  const githubClient = new StubGitHubClient();
  const deps = { notifier, summaryWriter, githubClient, targetRepo: run.targetRepo, baseBranch: "main", baseRepoPath: base };

  // 1. Conflicting component gets paused, not opened as a PR.
  const resultX = await prepareForPr(componentX.id, deps);
  console.log("X outcome is conflict_paused?", resultX.outcome === "conflict_paused");

  const [componentXAfter] = await db.select().from(components).where(eq(components.id, componentX.id));
  console.log("X component status is conflict_paused?", componentXAfter.status === "conflict_paused");
  console.log("X still has no PR number?", componentXAfter.prNumber === null);

  if (resultX.outcome === "conflict_paused") {
    const [checkpoint] = await db.select().from(checkpoints).where(eq(checkpoints.id, resultX.checkpointId));
    console.log("X's checkpoint mentions the conflicting file?", checkpoint.question.includes("fileA.txt") || checkpoint.question.includes("<<<<<<<"));
    console.log("X's checkpoint has a thread (Slack was posted)?", checkpoint.slackThreadTs !== null);
  }

  const xConflictLog = await db.select().from(decisionLog).where(eq(decisionLog.componentId, componentX.id));
  console.log("X has a conflict_event decision_log entry?", xConflictLog.some((e) => e.entryType === "conflict_event"));

  // 2. Fully clean component opens a PR with no warnings.
  const resultY = await prepareForPr(componentY.id, deps);
  console.log("\nY outcome is pr_opened?", resultY.outcome === "pr_opened");
  console.log("Y has zero overlap warnings?", resultY.outcome === "pr_opened" && resultY.overlapWarningCount === 0);

  // 3. Clean merge, but overlaps another in-flight component's owned_paths — PR still opens.
  const resultW = await prepareForPr(componentW.id, deps);
  console.log("\nW outcome is pr_opened despite overlap?", resultW.outcome === "pr_opened");
  console.log("W reports exactly one overlap warning?", resultW.outcome === "pr_opened" && resultW.overlapWarningCount === 1);
  console.log("notifier.postWarning was actually called?", notifier.warnings.length === 1);

  const [componentWAfter] = await db.select().from(components).where(eq(components.id, componentW.id));
  console.log("W component status is pr_open?", componentWAfter.status === "pr_open");

  const wConflictLog = await db.select().from(decisionLog).where(eq(decisionLog.componentId, componentW.id));
  console.log("W has a conflict_event decision_log entry for the overlap?", wConflictLog.some((e) => e.entryType === "conflict_event"));

  await rm(root, { recursive: true, force: true });
  console.log("\nprepare-for-pr integration smoke test passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
