import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { checkpoints, components, decisionLog } from "../db/schema.js";
import type { Notifier } from "../notifier/types.js";
import type { CircuitBreakerAction } from "./circuit-breaker.js";

export interface PauseForRunawayDeps {
  notifier: Notifier;
}

export interface PauseForRunawayResult {
  checkpointId: number;
}

// Fires when the circuit breaker (this module) returns graceful_stop —
// either the local runaway ceiling or the shared usage ceiling tripped.
// Deliberately reuses the same checkpoint/resolve/resume machinery as
// ask_human and pauseForMergeConflict rather than inventing a third pause
// mechanism, for the same reason both of those already do: it gets startup
// reconciliation's crash-recovery guarantee for free, and the human
// resumption path (module 5) doesn't need to know or care why the
// component paused.
export async function pauseForRunaway(
  componentId: number,
  action: CircuitBreakerAction & { type: "graceful_stop" },
  deps: PauseForRunawayDeps,
): Promise<PauseForRunawayResult> {
  const question =
    action.reason === "runaway"
      ? `This component was automatically stopped: it appeared stuck (${action.detail}). Its worktree may be mid-change — review the last commit and decide how to proceed.`
      : `This component was automatically stopped to protect your shared usage budget (${action.detail}). Its worktree may be mid-change — review the last commit and decide how to proceed.`;

  await db.update(components).set({ status: "usage_paused", updatedAt: new Date() }).where(eq(components.id, componentId));

  const [checkpoint] = await db.insert(checkpoints).values({ componentId, question }).returning();

  const { slackThreadTs, slackChannel } = await deps.notifier.postCheckpoint({ componentId, question });
  await db.update(checkpoints).set({ slackThreadTs, slackChannel }).where(eq(checkpoints.id, checkpoint.id));

  await db.insert(decisionLog).values({
    componentId,
    entryType: "runaway_event",
    content: `${action.reason}: ${action.detail}`,
  });

  return { checkpointId: checkpoint.id };
}
