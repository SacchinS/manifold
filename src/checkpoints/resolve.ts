import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { checkpoints, components, decisionLog } from "../db/schema.js";
import type { SessionResumer } from "../session-resumer/types.js";

export interface ResolveCheckpointDeps {
  sessionResumer: SessionResumer;
}

export interface ResolveCheckpointResult {
  resolved: boolean;
}

// Module 5 in manifold-handoff.md. The conditional UPDATE (status='pending'
// guard) is what makes this idempotent: a double-fire from Slack, or two
// people replying to the same thread, only resumes the session once — the
// second call sees zero rows affected and stops.
//
// Deliberately does NOT write components.status itself, in either order.
// Resuming a real branch agent isn't a quick hand-off — it runs the agent
// to its next natural stopping point, which might be another ask_human call,
// mark_ready_for_pr, a circuit-breaker stop, or just finishing quietly. Each
// of those already owns setting the correct final status as part of
// handling itself; resolveCheckpoint writing status after awaiting resume()
// would always be racing (and losing) against whichever of those already
// wrote the real answer, and writing it before would hide a resume failure
// behind a component that looks healthy while nothing is running. Every
// SessionResumer implementation is responsible for leaving components.status
// correct by the time resume() returns — see RealSessionResumer's use of
// runBranchAgent's own end-of-run status logic, and StubSessionResumer's
// direct write standing in for it. This also means the crash-window
// reconciliation (module 6) scans for is simpler than before: status
// unchanged from its pre-resolve paused value, with the checkpoint already
// resolved underneath it, in EITHER a resolveCheckpoint crash or a resumer
// crash.
export async function resolveCheckpoint(
  checkpointId: number,
  answer: string,
  deps: ResolveCheckpointDeps,
): Promise<ResolveCheckpointResult> {
  const resolvedRows = await db
    .update(checkpoints)
    .set({ status: "resolved", answer, resolvedAt: new Date() })
    .where(and(eq(checkpoints.id, checkpointId), eq(checkpoints.status, "pending")))
    .returning();

  if (resolvedRows.length === 0) {
    return { resolved: false };
  }
  const checkpoint = resolvedRows[0];

  await db.insert(decisionLog).values({
    componentId: checkpoint.componentId,
    entryType: "checkpoint_resolved",
    content: `Q: ${checkpoint.question}\nA: ${answer}`,
  });

  const [component] = await db.select().from(components).where(eq(components.id, checkpoint.componentId));

  if (component.sessionId) {
    await deps.sessionResumer.resume({
      componentId: component.id,
      sessionId: component.sessionId,
      answer,
    });
  }

  return { resolved: true };
}
