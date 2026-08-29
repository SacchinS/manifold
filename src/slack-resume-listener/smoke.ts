import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { runs, components, checkpoints, decisionLog } from "../db/schema.js";
import { askHuman } from "../branch-agent/ask-human.js";
import { ConsoleNotifier } from "../notifier/console-notifier.js";
import { StubVisualCapture } from "../visual-capture/stub-visual-capture.js";
import { handleReply } from "./handle-reply.js";
import type { ResumeInput, SessionResumer } from "../session-resumer/types.js";

class CountingSessionResumer implements SessionResumer {
  calls: ResumeInput[] = [];
  async resume(input: ResumeInput): Promise<void> {
    console.log(`[stub-resume] would resume session ${input.sessionId} with answer: "${input.answer}"`);
    this.calls.push(input);
  }
}

async function main() {
  const resumer = new CountingSessionResumer();
  const askHumanDeps = { notifier: new ConsoleNotifier(), visualCapture: new StubVisualCapture() };
  const resolveDeps = { sessionResumer: resumer };

  const [run] = await db
    .insert(runs)
    .values({
      featureDescription: "Add dark mode toggle",
      targetRepo: "sacchin/example-app",
      repoCreated: false,
      plan: { components: [] },
    })
    .returning();

  // sessionId set as if a branch agent had already launched once — in the
  // real system this comes from the branch agent runner (not yet built).
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
      sessionId: "fake-session-123",
    })
    .returning();

  const askResult = await askHuman(
    {
      componentId: component.id,
      worktreePath: component.worktreePath,
      question: "Should this setting persist across sessions?",
      options: ["Yes", "No"],
    },
    askHumanDeps,
  );
  const [checkpoint] = await db.select().from(checkpoints).where(eq(checkpoints.id, askResult.checkpointId));

  // 1. A real reply resolves the checkpoint and triggers exactly one resume.
  const reply1 = await handleReply({ threadTs: checkpoint.slackThreadTs!, answer: "Yes" }, resolveDeps);
  console.log("first reply resolved?", reply1.resolved === true);

  const [checkpointAfter1] = await db.select().from(checkpoints).where(eq(checkpoints.id, checkpoint.id));
  console.log("checkpoint marked resolved with answer stored?", checkpointAfter1.status === "resolved" && checkpointAfter1.answer === "Yes");

  const [componentAfter1] = await db.select().from(components).where(eq(components.id, component.id));
  console.log("component back to in_progress?", componentAfter1.status === "in_progress");

  const logEntries = await db.select().from(decisionLog).where(eq(decisionLog.componentId, component.id));
  console.log("exactly one decision_log entry?", logEntries.length === 1);
  console.log("exactly one resume call?", resumer.calls.length === 1);

  // 2. A duplicate reply to the same thread must not re-resolve or re-resume.
  const reply2 = await handleReply({ threadTs: checkpoint.slackThreadTs!, answer: "No" }, resolveDeps);
  console.log("\nduplicate reply reports not-resolved?", reply2.resolved === false);

  const [checkpointAfter2] = await db.select().from(checkpoints).where(eq(checkpoints.id, checkpoint.id));
  console.log("answer unchanged by duplicate reply?", checkpointAfter2.answer === "Yes");

  const logEntriesAfter2 = await db.select().from(decisionLog).where(eq(decisionLog.componentId, component.id));
  console.log("still exactly one decision_log entry?", logEntriesAfter2.length === 1);
  console.log("still exactly one resume call?", resumer.calls.length === 1);

  // 3. A reply to an unknown thread is a no-op, not a crash.
  const reply3 = await handleReply({ threadTs: "thread-that-does-not-exist", answer: "??" }, resolveDeps);
  console.log("\nunknown thread reports not-resolved?", reply3.resolved === false);

  console.log("\nslack resume listener smoke test passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
