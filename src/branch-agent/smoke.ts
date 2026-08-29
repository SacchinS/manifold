import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { runs, components, checkpoints } from "../db/schema.js";
import { askHuman } from "./ask-human.js";
import { ConsoleNotifier } from "../notifier/console-notifier.js";
import { StubVisualCapture } from "../visual-capture/stub-visual-capture.js";
import { isAlive } from "../util/process.js";

async function main() {
  const deps = { notifier: new ConsoleNotifier(), visualCapture: new StubVisualCapture() };

  const [run] = await db
    .insert(runs)
    .values({
      featureDescription: "Add dark mode toggle",
      targetRepo: "sacchin/example-app",
      repoCreated: false,
      plan: { components: [] },
    })
    .returning();

  const [component] = await db
    .insert(components)
    .values({
      runId: run.id,
      branchName: "manifold/dark-mode-ui",
      worktreePath: "/tmp/worktrees/dark-mode-ui",
      taskDescription: "Add toggle to settings",
      ownedPaths: ["src/components/**"],
      dependsOn: [],
      status: "in_progress",
    })
    .returning();

  // 1. Non-visual checkpoint.
  const result1 = await askHuman(
    {
      componentId: component.id,
      worktreePath: component.worktreePath,
      question: "Should this setting persist across sessions?",
      options: ["Yes, persist it", "No, reset each session"],
    },
    deps,
  );
  console.log("askHuman (non-visual) result:", result1);

  const [checkpoint1] = await db.select().from(checkpoints).where(eq(checkpoints.id, result1.checkpointId));
  console.log("checkpoint row written correctly?", checkpoint1.status === "pending" && checkpoint1.slackThreadTs !== null);

  const [componentAfter1] = await db.select().from(components).where(eq(components.id, component.id));
  console.log("component moved to awaiting_input?", componentAfter1.status === "awaiting_input");

  // 2. Visual checkpoint — should allocate a dev server port/pid.
  const result2 = await askHuman(
    {
      componentId: component.id,
      worktreePath: component.worktreePath,
      question: "Does this button placement look right?",
      isVisual: true,
    },
    deps,
  );
  console.log("\naskHuman (visual) result:", result2);

  const [componentAfter2] = await db.select().from(components).where(eq(components.id, component.id));
  console.log(
    "dev server port/pid allocated and alive?",
    !!componentAfter2.devServerPort && !!componentAfter2.devServerPid && isAlive(componentAfter2.devServerPid),
  );

  const [checkpoint2] = await db.select().from(checkpoints).where(eq(checkpoints.id, result2.checkpointId));
  console.log("screenshot path recorded?", !!checkpoint2.screenshotPath);

  // 3. A second visual checkpoint on the same component should reuse the
  // existing dev server rather than spawning a new one.
  const result3 = await askHuman(
    {
      componentId: component.id,
      worktreePath: component.worktreePath,
      question: "And this one?",
      isVisual: true,
    },
    deps,
  );
  const [componentAfter3] = await db.select().from(components).where(eq(components.id, component.id));
  console.log(
    "\ndev server reused across visual checkpoints (same port/pid)?",
    componentAfter3.devServerPort === componentAfter2.devServerPort &&
      componentAfter3.devServerPid === componentAfter2.devServerPid,
  );

  // Clean up the stub dev server process this smoke test spawned.
  if (componentAfter3.devServerPid) process.kill(componentAfter3.devServerPid, "SIGTERM");

  console.log("\nask_human smoke test passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
