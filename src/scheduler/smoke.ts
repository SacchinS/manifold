import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { runs, components } from "../db/schema.js";
import { hasCycle } from "./dag.js";
import { findLaunchableComponents } from "./scheduler.js";
import { schedulerTick } from "./tick.js";
import { StubComponentLauncher } from "../component-launcher/stub-component-launcher.js";

const execFile = promisify(execFileCb);

function checkDagFixtures() {
  const linearChain = [
    { id: 1, dependsOn: [] },
    { id: 2, dependsOn: [1] },
    { id: 3, dependsOn: [2] },
  ];
  console.log("linear chain: no cycle?", hasCycle(linearChain) === false);

  const diamond = [
    { id: 1, dependsOn: [] },
    { id: 2, dependsOn: [1] },
    { id: 3, dependsOn: [1] },
    { id: 4, dependsOn: [2, 3] },
  ];
  console.log("diamond: no cycle?", hasCycle(diamond) === false);

  const twoNodeCycle = [
    { id: 1, dependsOn: [2] },
    { id: 2, dependsOn: [1] },
  ];
  console.log("two-node cycle: detected?", hasCycle(twoNodeCycle) === true);

  const selfCycleViaChain = [
    { id: 1, dependsOn: [3] },
    { id: 2, dependsOn: [1] },
    { id: 3, dependsOn: [2] },
  ];
  console.log("three-node cycle via chain: detected?", hasCycle(selfCycleViaChain) === true);
}

function checkFindLaunchableFixtures() {
  const fixture = [
    { id: 1, status: "merged", dependsOn: [] },
    { id: 2, status: "blocked_on_deps", dependsOn: [1] }, // dep merged -> launchable
    { id: 3, status: "blocked_on_deps", dependsOn: [2] }, // dep not merged yet -> not launchable
    { id: 4, status: "in_progress", dependsOn: [] }, // already running -> not a candidate
    { id: 5, status: "blocked_on_deps", dependsOn: [] }, // no deps -> launchable immediately
  ];
  const launchable = findLaunchableComponents(fixture).sort();
  console.log("pure scheduler picks exactly [2, 5]?", JSON.stringify(launchable) === JSON.stringify([2, 5]));
}

async function checkSchedulerTickIntegration() {
  const root = await mkdtemp(path.join(tmpdir(), "manifold-scheduler-smoke-"));
  const baseRepoPath = path.join(root, "base");
  await execFile("git", ["init", "-q", "-b", "main", baseRepoPath]);
  await execFile("git", ["config", "user.email", "smoke@manifold.test"], { cwd: baseRepoPath });
  await execFile("git", ["config", "user.name", "Manifold Smoke Test"], { cwd: baseRepoPath });
  await execFile("git", ["commit", "--allow-empty", "-q", "-m", "initial commit"], { cwd: baseRepoPath });

  const [run] = await db
    .insert(runs)
    .values({ featureDescription: "scheduler smoke", targetRepo: "sacchin/example-app", repoCreated: false, plan: {} })
    .returning();

  // Diamond: A has no deps, B and C both depend on A, D depends on B and C.
  const [a] = await db
    .insert(components)
    .values(componentRow(run.id, "A", root, []))
    .returning();
  const [b] = await db
    .insert(components)
    .values(componentRow(run.id, "B", root, [a.id]))
    .returning();
  const [c] = await db
    .insert(components)
    .values(componentRow(run.id, "C", root, [a.id]))
    .returning();
  const [d] = await db
    .insert(components)
    .values(componentRow(run.id, "D", root, [b.id, c.id]))
    .returning();

  const launcher = new StubComponentLauncher();
  const deps = { baseRepoPath, launcher };

  const tick1 = await schedulerTick(run.id, deps);
  console.log("\ntick 1 launches only A?", JSON.stringify(tick1.sort()) === JSON.stringify([a.id]));

  const tick2 = await schedulerTick(run.id, deps);
  console.log("tick 2 (A still running) launches nothing new?", tick2.length === 0);

  await markMerged(a.id);
  const tick3 = await schedulerTick(run.id, deps);
  console.log("tick 3 (A merged) launches B and C?", JSON.stringify(tick3.sort()) === JSON.stringify([b.id, c.id].sort()));

  const tick4 = await schedulerTick(run.id, deps);
  console.log("tick 4 (B, C still running) launches nothing new?", tick4.length === 0);

  await markMerged(b.id);
  const tick5 = await schedulerTick(run.id, deps);
  console.log("tick 5 (only B merged, C not yet) launches nothing (D needs both)?", tick5.length === 0);

  await markMerged(c.id);
  const tick6 = await schedulerTick(run.id, deps);
  console.log("tick 6 (B and C merged) launches D?", JSON.stringify(tick6) === JSON.stringify([d.id]));

  const [dAfter] = await db.select().from(components).where(eq(components.id, d.id));
  console.log("D has a session_id and is in_progress?", dAfter.status === "in_progress" && !!dAfter.sessionId);

  await rm(root, { recursive: true, force: true });
}

function componentRow(runId: number, label: string, root: string, dependsOn: number[]) {
  return {
    runId,
    branchName: `manifold/${label.toLowerCase()}`,
    worktreePath: path.join(root, `wt-${label}`),
    taskDescription: `component ${label}`,
    ownedPaths: [],
    dependsOn,
    status: "blocked_on_deps" as const,
  };
}

async function markMerged(componentId: number) {
  await db.update(components).set({ status: "merged", updatedAt: new Date() }).where(eq(components.id, componentId));
}

async function main() {
  checkDagFixtures();
  checkFindLaunchableFixtures();
  await checkSchedulerTickIntegration();
  console.log("\nscheduler smoke test passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
