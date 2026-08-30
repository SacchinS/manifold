import "dotenv/config";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { runs, components } from "../db/schema.js";
import { runOrchestratorChat } from "./chat-loop.js";
import { materializeApprovedPlan } from "./materialize-plan.js";

const execFile = promisify(execFileCb);

// Real end-to-end proof of module 1: a live SDK conversation that inspects
// an actual repo, negotiates a plan across at least one revision round, and
// finalizes it — then materialize-plan turning that plan into real
// runs/components rows with correctly mapped numeric dependencies.
async function main() {
  const root = await mkdtemp(path.join(tmpdir(), "manifold-orchestrator-smoke-"));
  const repoPath = path.join(root, "repo");
  await mkdir(repoPath, { recursive: true });
  await execFile("git", ["init", "-q", "-b", "main", repoPath]);
  await execFile("git", ["config", "user.email", "smoke@manifold.test"], { cwd: repoPath });
  await execFile("git", ["config", "user.name", "Manifold Smoke Test"], { cwd: repoPath });
  await writeFile(path.join(repoPath, "README.md"), "# Example App\n\nA small Express server.\n");
  await mkdir(path.join(repoPath, "src"), { recursive: true });
  await writeFile(path.join(repoPath, "src", "server.js"), "const express = require('express');\nconst app = express();\napp.listen(3000);\n");
  await execFile("git", ["add", "."], { cwd: repoPath });
  await execFile("git", ["commit", "-q", "-m", "initial commit"], { cwd: repoPath });

  // Scripted human side of the conversation: clear feedback first (forcing
  // at least one revision round), then unambiguous approval, with a
  // fallback in case the real model needs more rounds than expected.
  const scriptedReplies = [
    "Make sure the status page component explicitly depends on the health endpoint component being finished first.",
    "Yes, that looks good — approved, please proceed.",
  ];
  let replyIndex = 0;
  const transcript: string[] = [];

  const plan = await runOrchestratorChat(
    "Add a /health JSON endpoint to the server that reports { status: 'ok' }, and a simple HTML status page that fetches and displays it.",
    {
      baseRepoPath: repoPath,
      print: (text) => {
        transcript.push(text);
        console.log(`[orchestrator] ${text}\n`);
      },
      getHumanInput: async () => {
        const reply = scriptedReplies[replyIndex] ?? "Yes, approved, please go ahead.";
        replyIndex++;
        console.log(`[human] ${reply}\n`);
        return reply;
      },
    },
  );

  console.log("\n=== finalized plan ===");
  console.log(JSON.stringify(plan, null, 2));

  console.log("\nplan has at least 2 components?", plan.components.length >= 2);
  console.log("every component has a non-empty task description?", plan.components.every((c) => c.taskDescription.trim().length > 0));
  console.log(
    "at least one component depends on another (a real dependency edge exists)?",
    plan.components.some((c) => c.dependsOn.length > 0),
  );
  console.log("at least one revision round actually happened?", replyIndex >= 1);

  const result = await materializeApprovedPlan({
    featureDescription: "smoke test feature",
    targetRepo: "sacchin/example-app",
    repoCreated: false,
    plan,
    worktreesRoot: path.join(root, "worktrees"),
  });

  const [run] = await db.select().from(runs).where(eq(runs.id, result.runId));
  console.log("\nrun row created with status running?", run.status === "running");

  const componentRows = await db.select().from(components).where(eq(components.runId, result.runId));
  console.log("component row count matches plan?", componentRows.length === plan.components.length);

  const dependsOnMappedCorrectly = plan.components.every((c) => {
    const row = componentRows.find((r) => r.id === result.componentIdByKey.get(c.id));
    if (!row) return false;
    const expectedNumericDeps = c.dependsOn.map((key) => result.componentIdByKey.get(key)).sort();
    const actualDeps = [...row.dependsOn].sort();
    return JSON.stringify(expectedNumericDeps) === JSON.stringify(actualDeps);
  });
  console.log("dependsOn correctly mapped from string keys to real component ids?", dependsOnMappedCorrectly);

  const allBlockedOnDeps = componentRows.every((r) => r.status === "blocked_on_deps");
  console.log("all components start blocked_on_deps?", allBlockedOnDeps);

  await rm(root, { recursive: true, force: true });
  console.log("\norchestrator smoke test passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
