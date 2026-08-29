import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { checkpoints, components, decisionLog } from "../db/schema.js";
import type { Notifier } from "../notifier/types.js";
import type { MergeConflictCheckResult } from "./check-merge-conflict.js";

export interface PauseForConflictDeps {
  notifier: Notifier;
}

export interface PauseForConflictResult {
  checkpointId: number;
}

// Module 7, path 1 in manifold-handoff.md. Deliberately reuses the same
// checkpoint/resolve/resume machinery as ask_human (module 4) rather than
// inventing a second pause mechanism — a merge conflict is exactly the same
// shape of problem ("pause, wait for a human, resume with their answer"),
// so it gets the same crash-recovery guarantees from startup reconciliation
// (module 6) for free. Written pending, with no thread yet, before the
// Slack post, same ordering ask_human uses.
export async function pauseForMergeConflict(
  componentId: number,
  conflict: Required<Pick<MergeConflictCheckResult, "conflictDetails" | "commitsOnMainSinceBranchStart">>,
  deps: PauseForConflictDeps,
): Promise<PauseForConflictResult> {
  const question = [
    "This branch no longer merges cleanly against main. How should it be resolved?",
    "",
    "Commits landed on main since this branch started:",
    conflict.commitsOnMainSinceBranchStart.length
      ? conflict.commitsOnMainSinceBranchStart.map((line) => `- ${line}`).join("\n")
      : "(none)",
    "",
    "Conflicting hunks:",
    conflict.conflictDetails,
  ].join("\n");

  await db.update(components).set({ status: "conflict_paused", updatedAt: new Date() }).where(eq(components.id, componentId));

  const [checkpoint] = await db.insert(checkpoints).values({ componentId, question }).returning();

  const { slackThreadTs, slackChannel } = await deps.notifier.postCheckpoint({ componentId, question });
  await db.update(checkpoints).set({ slackThreadTs, slackChannel }).where(eq(checkpoints.id, checkpoint.id));

  await db.insert(decisionLog).values({
    componentId,
    entryType: "conflict_event",
    content: "Merge conflict detected against main; paused and asked for human instruction.",
  });

  return { checkpointId: checkpoint.id };
}
