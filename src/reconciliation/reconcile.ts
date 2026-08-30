import { desc, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { checkpoints, components } from "../db/schema.js";
import type { Notifier } from "../notifier/types.js";
import type { SessionResumer } from "../session-resumer/types.js";

export interface ReconcileDeps {
  notifier: Notifier;
  sessionResumer: SessionResumer;
}

export interface ReconcileReport {
  orphanedCheckpointsFound: number;
  orphanedCheckpointsRepaired: number;
  orphanedCheckpointsNeedingAttention: number;
  stuckResumesFound: number;
  stuckResumesRepaired: number;
}

// Module 6 in manifold-handoff.md. Run once at process startup (and safe to
// re-run manually at any time — every step here is a no-op on already-healthy
// rows). Repairs the two specific crash windows the design has:
//
//   1. ask_human (module 4) inserts a checkpoint row *before* posting to
//      Slack, then updates it with slack_thread_ts *after*. A crash between
//      those two writes leaves a pending checkpoint with no thread — it can
//      never be answered because there's nothing to reply to.
//   2. resolveCheckpoint (module 5) resumes the session *before* flipping
//      the component's status back to in_progress. A crash between those
//      leaves the component sitting in awaiting_input with its checkpoint
//      already resolved — the resume should have fired but didn't.
export async function reconcile(deps: ReconcileDeps): Promise<ReconcileReport> {
  const orphaned = await reconcileOrphanedCheckpoints(deps.notifier);
  const stuck = await reconcileStuckResumes(deps.sessionResumer);
  return { ...orphaned, ...stuck };
}

async function reconcileOrphanedCheckpoints(notifier: Notifier) {
  const orphaned = await db
    .select()
    .from(checkpoints)
    .where(eq(checkpoints.status, "pending"));
  const withoutThread = orphaned.filter((c) => c.slackThreadTs === null);

  let repaired = 0;
  let needingAttention = 0;

  for (const checkpoint of withoutThread) {
    try {
      const { slackThreadTs, slackChannel } = await notifier.postCheckpoint({
        componentId: checkpoint.componentId,
        question: checkpoint.question,
        options: checkpoint.options,
        screenshotPath: checkpoint.screenshotPath,
      });
      await db.update(checkpoints).set({ slackThreadTs, slackChannel }).where(eq(checkpoints.id, checkpoint.id));
      repaired++;
    } catch (err) {
      // Left as pending with no thread — will be retried on the next
      // reconciliation pass. Logged loudly since there's no other signal
      // that this checkpoint is stuck.
      console.error(
        `[reconciliation] failed to re-post orphaned checkpoint ${checkpoint.id} (component ${checkpoint.componentId}); needs manual attention:`,
        err,
      );
      needingAttention++;
    }
  }

  return {
    orphanedCheckpointsFound: withoutThread.length,
    orphanedCheckpointsRepaired: repaired,
    orphanedCheckpointsNeedingAttention: needingAttention,
  };
}

async function reconcileStuckResumes(sessionResumer: SessionResumer) {
  // conflict_paused (module 7) and usage_paused (usage guard) both reuse the
  // same checkpoint/resume mechanism as awaiting_input (module 4's
  // ask_human), so a crash between resolving one of their checkpoints and
  // firing the resume looks the same way here regardless of which one it is.
  const waitingOnHuman = await db
    .select()
    .from(components)
    .where(inArray(components.status, ["awaiting_input", "conflict_paused", "usage_paused"]));

  let stuckFound = 0;
  let repaired = 0;

  for (const component of waitingOnHuman) {
    const [latestCheckpoint] = await db
      .select()
      .from(checkpoints)
      .where(eq(checkpoints.componentId, component.id))
      .orderBy(desc(checkpoints.id))
      .limit(1);

    if (!latestCheckpoint || latestCheckpoint.status !== "resolved") continue;

    stuckFound++;

    if (!component.sessionId || latestCheckpoint.answer === null) {
      console.error(
        `[reconciliation] component ${component.id} is stuck in ${component.status} with a resolved checkpoint but is missing a session_id or answer; needs manual attention`,
      );
      continue;
    }

    try {
      await sessionResumer.resume({
        componentId: component.id,
        sessionId: component.sessionId,
        answer: latestCheckpoint.answer,
      });
      await db
        .update(components)
        .set({ status: "in_progress", updatedAt: new Date() })
        .where(eq(components.id, component.id));
      repaired++;
    } catch (err) {
      console.error(`[reconciliation] failed to re-fire resume for component ${component.id}:`, err);
    }
  }

  return { stuckResumesFound: stuckFound, stuckResumesRepaired: repaired };
}
