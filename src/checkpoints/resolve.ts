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
// Resume is fired *before* the component's status flips back to
// in_progress, deliberately. If the process dies between resolving the
// checkpoint and actually resuming the session, the component is left
// sitting in awaiting_input with a resolved checkpoint underneath it — an
// inconsistent, detectable state that startup reconciliation (module 6)
// scans for and repairs. Flipping the status first would hide that failure
// behind a component that looks healthy while nothing is actually running.
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

  await db.update(components).set({ status: "in_progress", updatedAt: new Date() }).where(eq(components.id, component.id));

  return { resolved: true };
}
