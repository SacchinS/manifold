import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { runs, components, checkpoints } from "../db/schema.js";
import { ConsoleNotifier } from "../notifier/console-notifier.js";
import type { PostCheckpointInput, PostCheckpointResult } from "../notifier/types.js";
import type { ResumeInput, SessionResumer } from "../session-resumer/types.js";
import { reconcile } from "./reconcile.js";

// Throws for one specific question (simulating a notifier failure) and
// otherwise behaves like the real stub.
class FlakyNotifier extends ConsoleNotifier {
  async postCheckpoint(input: PostCheckpointInput): Promise<PostCheckpointResult> {
    if (input.question.includes("UNPOSTABLE")) {
      throw new Error("simulated Slack outage");
    }
    return super.postCheckpoint(input);
  }
}

class CountingSessionResumer implements SessionResumer {
  calls: ResumeInput[] = [];
  async resume(input: ResumeInput): Promise<void> {
    console.log(`[stub-resume] would resume session ${input.sessionId} with answer: "${input.answer}"`);
    this.calls.push(input);
  }
}

async function makeRun() {
  const [run] = await db
    .insert(runs)
    .values({ featureDescription: "reconciliation smoke", targetRepo: "sacchin/example-app", repoCreated: false, plan: {} })
    .returning();
  return run;
}

async function main() {
  const notifier = new FlakyNotifier();
  const resumer = new CountingSessionResumer();

  const run = await makeRun();

  // --- Scenario A: orphaned checkpoint (crash between insert and Slack post) ---
  const [componentA] = await db
    .insert(components)
    .values({
      runId: run.id,
      branchName: "manifold/scenario-a",
      worktreePath: "/tmp/worktrees/scenario-a",
      taskDescription: "orphaned checkpoint repro",
      ownedPaths: [],
      dependsOn: [],
      status: "awaiting_input",
      sessionId: "session-a",
    })
    .returning();

  const [orphanedCheckpoint] = await db
    .insert(checkpoints)
    .values({
      componentId: componentA.id,
      question: "Orphaned: never made it to Slack before the crash",
      status: "pending",
      // slackThreadTs / slackChannel deliberately left null
    })
    .returning();

  // --- Scenario B: stuck resume (crash between checkpoint resolve and resume) ---
  const [componentB] = await db
    .insert(components)
    .values({
      runId: run.id,
      branchName: "manifold/scenario-b",
      worktreePath: "/tmp/worktrees/scenario-b",
      taskDescription: "stuck resume repro",
      ownedPaths: [],
      dependsOn: [],
      status: "awaiting_input",
      sessionId: "session-b",
    })
    .returning();

  await db.insert(checkpoints).values({
    componentId: componentB.id,
    question: "Stuck: resolved but resume never fired before the crash",
    status: "resolved",
    answer: "Go with option B",
    resolvedAt: new Date(),
  });

  // --- Scenario C: orphaned checkpoint whose re-post fails (Slack still down) ---
  const [componentC] = await db
    .insert(components)
    .values({
      runId: run.id,
      branchName: "manifold/scenario-c",
      worktreePath: "/tmp/worktrees/scenario-c",
      taskDescription: "notifier failure repro",
      ownedPaths: [],
      dependsOn: [],
      status: "awaiting_input",
      sessionId: "session-c",
    })
    .returning();

  await db.insert(checkpoints).values({
    componentId: componentC.id,
    question: "UNPOSTABLE: this one should stay stuck and get logged",
    status: "pending",
  });

  // --- Run reconciliation ---
  const report = await reconcile({ notifier, sessionResumer: resumer });
  console.log("\nreconciliation report:", report);

  console.log(
    "\nfound both the orphaned checkpoint and the unpostable one?",
    report.orphanedCheckpointsFound === 2,
  );
  console.log("repaired exactly the postable one?", report.orphanedCheckpointsRepaired === 1);
  console.log("flagged exactly the unpostable one?", report.orphanedCheckpointsNeedingAttention === 1);
  console.log("found the stuck resume?", report.stuckResumesFound === 1);
  console.log("repaired the stuck resume?", report.stuckResumesRepaired === 1);
  console.log("resume actually re-fired for scenario B?", resumer.calls.some((c) => c.sessionId === "session-b"));

  const [checkpointAAfter] = await db.select().from(checkpoints).where(eq(checkpoints.id, orphanedCheckpoint.id));
  console.log("orphaned checkpoint now has a thread?", checkpointAAfter.slackThreadTs !== null);

  const [componentBAfter] = await db.select().from(components).where(eq(components.id, componentB.id));
  console.log("stuck component flipped back to in_progress?", componentBAfter.status === "in_progress");

  const [componentCAfter] = await db.select().from(components).where(eq(components.id, componentC.id));
  console.log("unpostable component left untouched (still awaiting_input)?", componentCAfter.status === "awaiting_input");

  // --- Re-run: should be idempotent, and should retry the still-stuck one ---
  const report2 = await reconcile({ notifier, sessionResumer: resumer });
  console.log("\nsecond pass report:", report2);
  console.log("nothing left to repair for A or B?", report2.orphanedCheckpointsRepaired === 0 && report2.stuckResumesFound === 0);
  console.log("C still flagged as needing attention on retry?", report2.orphanedCheckpointsNeedingAttention === 1);

  console.log("\nreconciliation smoke test passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
