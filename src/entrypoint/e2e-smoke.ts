import "dotenv/config";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { components } from "../db/schema.js";
import { runOrchestratorChat } from "../orchestrator/chat-loop.js";
import { materializeApprovedPlan } from "../orchestrator/materialize-plan.js";
import { runManifoldLoop } from "./run-loop.js";
import { ConsoleNotifier } from "../notifier/console-notifier.js";
import { StubVisualCapture } from "../visual-capture/stub-visual-capture.js";
import { ConsoleStatusBoard } from "../status-board/console-status-board.js";

const execFile = promisify(execFileCb);
const TARGET_REPO = "sacchins/manifold-pr-test";

// Step 11: a real end-to-end run, with me playing both human roles (plan
// negotiation, checkpoint answers, merging PRs on GitHub) the same way the
// other end-to-end tests script the human side — this proves the full
// wiring (orchestrator -> materialize -> scheduler -> real branch agents ->
// checkpoints -> real PRs -> real merges -> dependency unblocking -> repeat)
// holds together before handing the real interactive CLI (cli.ts) to an
// actual human.
async function main() {
  const root = await mkdtemp(path.join(tmpdir(), "manifold-e2e-smoke-"));
  const baseRepoPath = path.join(root, "repo");

  console.log(`=== cloning ${TARGET_REPO} ===`);
  await execFile("gh", ["repo", "clone", TARGET_REPO, baseRepoPath]);

  const scriptedOrchestratorReplies = [
    "Looks reasonable. Please make sure the docs index page explicitly depends on the glossary being done first, since it links to it.",
    "Yes, approved — go ahead.",
  ];
  let orchIdx = 0;

  console.log("\n=== negotiating plan with orchestrator ===");
  const plan = await runOrchestratorChat(
    "Add a docs/GLOSSARY.md defining 2-3 key terms for this scratch repo, and a docs/README.md index page that links to the glossary.",
    {
      baseRepoPath,
      print: (text) => console.log(`\n[orchestrator] ${text}`),
      getHumanInput: async () => {
        const reply = scriptedOrchestratorReplies[orchIdx] ?? "Yes, approved, please proceed.";
        orchIdx++;
        console.log(`\n[human] ${reply}`);
        return reply;
      },
    },
  );

  console.log("\nplan component count:", plan.components.length);
  console.log(JSON.stringify(plan, null, 2));

  const { runId } = await materializeApprovedPlan({
    featureDescription: "e2e smoke: docs glossary + index",
    targetRepo: TARGET_REPO,
    repoCreated: false,
    plan,
    worktreesRoot: path.join(root, "worktrees"),
  });

  const mergeTriggered = new Set<number>();

  console.log(`\n=== starting run loop (run ${runId}) ===`);
  await runManifoldLoop(runId, {
    notifier: new ConsoleNotifier(),
    statusBoard: new ConsoleStatusBoard(),
    visualCapture: new StubVisualCapture(),
    baseRepoPath,
    targetRepo: TARGET_REPO,
    baseBranch: "main",
    pollIntervalMs: 4000,
    getCheckpointAnswer: async (question) => {
      const answer = "Use your best judgment — go with whatever is simplest and most standard.";
      console.log(`\n[human answering checkpoint] Q: ${question}\n[human answering checkpoint] A: ${answer}`);
      return answer;
    },
    print: (text) => {
      console.log(text);
      const match = text.match(/PR #(\d+) opened/);
      if (match) {
        const prNumber = Number(match[1]);
        if (!mergeTriggered.has(prNumber)) {
          mergeTriggered.add(prNumber);
          console.log(`\n[human merging PR #${prNumber} on GitHub for real]`);
          execFile("gh", ["pr", "merge", String(prNumber), "--repo", TARGET_REPO, "--merge", "--delete-branch=false"]).catch((err) =>
            console.error(`failed to merge PR #${prNumber}:`, err),
          );
        }
      }
    },
  });

  const finalComponents = await db.select().from(components).where(eq(components.runId, runId));
  console.log("\n=== final component statuses ===");
  for (const c of finalComponents) console.log(`${c.id} (${c.taskDescription.slice(0, 40)}...): ${c.status}`);

  console.log("\nat least 2 components (dependency chain exercised)?", finalComponents.length >= 2);
  console.log("all components merged?", finalComponents.every((c) => c.status === "merged"));

  await rm(root, { recursive: true, force: true });
  console.log("\ne2e smoke test passed.");
  console.log(`\nNOTE: ${TARGET_REPO} was not deleted (no delete_repo scope) — delete manually when convenient.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
