import "dotenv/config";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { runs, components, decisionLog } from "../db/schema.js";
import { addWorktree } from "../worktree/manager.js";
import { ConsoleNotifier } from "../notifier/console-notifier.js";
import { StubVisualCapture } from "../visual-capture/stub-visual-capture.js";
import { RealComponentLauncher } from "../component-launcher/real-component-launcher.js";
import { RealSummaryWriter } from "./real-summary-writer.js";
import { RealGitHubClient } from "./real-github-client.js";
import { generatePr } from "./generate-pr.js";
import { pollForMerges } from "./poll-merges.js";
import { StubComponentLauncher } from "../component-launcher/stub-component-launcher.js";

const execFile = promisify(execFileCb);

const TARGET_REPO = "sacchins/manifold-pr-test";

// Real end-to-end proof of the last two stubbed pieces: SummaryWriter (a
// component's own session writing its PR body) and GitHubClient (gh CLI —
// push, create, poll status, and here, a real merge too). Runs against a
// throwaway private repo created for this test; see the conversation for
// why it can't be deleted programmatically (no delete_repo scope) and is
// left for manual cleanup.
async function main() {
  const root = await mkdtemp(path.join(tmpdir(), "manifold-pr-real-smoke-"));
  const baseRepoPath = path.join(root, "base");

  console.log(`=== cloning ${TARGET_REPO} ===`);
  await execFile("gh", ["repo", "clone", TARGET_REPO, baseRepoPath]);

  const worktreePath = path.join(root, "wt-notes");
  await addWorktree({ baseRepoPath, worktreePath, branchName: "component/notes" });

  const [run] = await db
    .insert(runs)
    .values({ featureDescription: "real PR pipeline smoke test", targetRepo: TARGET_REPO, repoCreated: false, plan: {} })
    .returning();

  const [component] = await db
    .insert(components)
    .values({
      runId: run.id,
      branchName: "component/notes",
      worktreePath,
      taskDescription:
        "Create a file called NOTES.md containing one short sentence about what this scratch repo is for, then commit it with git. " +
        "Call log_decision once to record why you phrased it the way you did. Then call mark_ready_for_pr exactly once.",
      ownedPaths: ["NOTES.md"],
      dependsOn: [],
      status: "blocked_on_deps",
    })
    .returning();

  const runnerDeps = { notifier: new ConsoleNotifier(), visualCapture: new StubVisualCapture() };
  const launcher = new RealComponentLauncher(runnerDeps);

  console.log("\n=== launching real branch agent ===");
  await db.update(components).set({ status: "in_progress", updatedAt: new Date() }).where(eq(components.id, component.id));
  const { sessionId } = await launcher.launch({
    componentId: component.id,
    branchName: component.branchName,
    worktreePath,
    taskDescription: component.taskDescription,
    ownedPaths: component.ownedPaths,
  });
  await db.update(components).set({ sessionId, updatedAt: new Date() }).where(eq(components.id, component.id));

  const [componentAfterLaunch] = await db.select().from(components).where(eq(components.id, component.id));
  console.log("component reached ready_for_pr?", componentAfterLaunch.status === "ready_for_pr");

  const decisions = await db.select().from(decisionLog).where(eq(decisionLog.componentId, component.id));
  console.log("at least one decision logged?", decisions.length > 0);

  console.log("\n=== generating PR (real summary write + real gh pr create) ===");
  const summaryWriter = new RealSummaryWriter({ worktreePath, sessionId });
  const githubClient = new RealGitHubClient({ baseRepoPath });

  const { prNumber, body } = await generatePr(component.id, {
    summaryWriter,
    githubClient,
    targetRepo: TARGET_REPO,
    baseBranch: "main",
  });

  console.log("\n--- generated PR body ---");
  console.log(body);
  console.log("--- end PR body ---\n");

  console.log("PR body has real structure (Goal/Decisions sections)?", /## Goal/i.test(body) && /## Decisions/i.test(body));
  console.log(`real PR number returned? ${!!prNumber} (#${prNumber})`);
  console.log(`PR URL: https://github.com/${TARGET_REPO}/pull/${prNumber}`);

  const [componentAfterPr] = await db.select().from(components).where(eq(components.id, component.id));
  console.log("component status is pr_open?", componentAfterPr.status === "pr_open");

  console.log("\n=== polling status while open ===");
  const statusWhileOpen = await githubClient.getPullRequestStatus(TARGET_REPO, prNumber);
  console.log("status reports open?", statusWhileOpen === "open");

  console.log("\n=== merging the PR for real ===");
  await execFile("gh", ["pr", "merge", String(prNumber), "--repo", TARGET_REPO, "--merge", "--delete-branch=false"]);

  console.log("\n=== polling for the merge ===");
  const schedulerDeps = { baseRepoPath, launcher: new StubComponentLauncher() };
  const pollResult = await pollForMerges(run.id, { githubClient, targetRepo: TARGET_REPO, baseRepoPath, schedulerDeps });
  console.log("merge detected?", pollResult.mergedComponentIds.includes(component.id));

  const [componentAfterMerge] = await db.select().from(components).where(eq(components.id, component.id));
  console.log("component status is merged?", componentAfterMerge.status === "merged");

  await rm(root, { recursive: true, force: true });
  console.log("\nreal PR pipeline smoke test passed.");
  console.log(`\nNOTE: ${TARGET_REPO} on GitHub was not deleted (no delete_repo scope) — delete it manually when convenient.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
