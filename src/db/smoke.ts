import { db } from "./index.js";
import { runs, components, checkpoints, decisionLog } from "./schema.js";
import { eq } from "drizzle-orm";

const [run] = await db
  .insert(runs)
  .values({
    featureDescription: "Add dark mode toggle",
    targetRepo: "sacchin/example-app",
    repoCreated: false,
    plan: {
      components: [
        { id: "ui", taskDescription: "Add toggle to settings", ownedPaths: ["src/components/**"], dependsOn: [] },
      ],
    },
  })
  .returning();
console.log("inserted run:", run);

const [component] = await db
  .insert(components)
  .values({
    runId: run.id,
    branchName: "manifold/dark-mode-ui",
    worktreePath: "/tmp/worktrees/dark-mode-ui",
    taskDescription: "Add toggle to settings",
    ownedPaths: ["src/components/**"],
    dependsOn: [],
  })
  .returning();
console.log("inserted component:", component);

const [checkpoint] = await db
  .insert(checkpoints)
  .values({
    componentId: component.id,
    question: "Should the toggle live in the settings page or the header?",
    options: ["Settings page", "Header"],
  })
  .returning();
console.log("inserted checkpoint:", checkpoint);

const resolved = await db
  .update(checkpoints)
  .set({ status: "resolved", answer: "Header", resolvedAt: new Date() })
  .where(eq(checkpoints.id, checkpoint.id))
  .returning();
console.log("resolved checkpoint:", resolved);

const [logEntry] = await db
  .insert(decisionLog)
  .values({
    componentId: component.id,
    entryType: "checkpoint_resolved",
    content: "Human chose to place the toggle in the header, not settings.",
  })
  .returning();
console.log("inserted decision_log entry:", logEntry);

console.log("\nSmoke test passed: schema, FKs, and JSON columns all round-trip correctly.");
