import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { checkpoints } from "../db/schema.js";
import { resolveCheckpoint, type ResolveCheckpointDeps } from "../checkpoints/resolve.js";

export interface SlackReply {
  threadTs: string;
  answer: string;
}

// Stands in for the Bolt event handler. Real wiring is: Bolt fires this on
// every thread reply; this function is the part that's testable without a
// live Slack connection. Module 5 in manifold-handoff.md.
export async function handleReply(reply: SlackReply, deps: ResolveCheckpointDeps): Promise<{ resolved: boolean }> {
  const [checkpoint] = await db.select().from(checkpoints).where(eq(checkpoints.slackThreadTs, reply.threadTs));

  if (!checkpoint) {
    console.warn(`[slack-resume-listener] no checkpoint found for thread_ts=${reply.threadTs}`);
    return { resolved: false };
  }

  return resolveCheckpoint(checkpoint.id, reply.answer, deps);
}
