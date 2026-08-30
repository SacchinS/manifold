import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { checkpoints, components } from "../db/schema.js";
import type { Notifier } from "../notifier/types.js";
import type { VisualCapture } from "../visual-capture/types.js";

export interface AskHumanInput {
  componentId: number;
  worktreePath: string;
  question: string;
  options?: string[];
  isVisual?: boolean;
}

export interface AskHumanDeps {
  notifier: Notifier;
  visualCapture: VisualCapture;
}

// What the tool_result for this call should carry, per manifold-handoff.md
// module 4 step 5: a placeholder, not the real answer. The Anthropic API
// requires a tool_use to be followed by a tool_result before the transcript
// can continue, but the actual answer only exists once a human replies in
// Slack — potentially long after this process has already exited (module 5
// resumes a fresh process with the answer as a new user message).
export interface AskHumanResult {
  status: "paused";
  message: string;
  checkpointId: number;
}

export async function askHuman(input: AskHumanInput, deps: AskHumanDeps): Promise<AskHumanResult> {
  let screenshotPath: string | null = null;

  if (input.isVisual) {
    const [component] = await db.select().from(components).where(eq(components.id, input.componentId));
    if (!component) throw new Error(`component ${input.componentId} not found`);

    const { port, pid } = await deps.visualCapture.ensureDevServer({
      worktreePath: input.worktreePath,
      existingPort: component.devServerPort,
      existingPid: component.devServerPid,
    });

    if (port !== component.devServerPort || pid !== component.devServerPid) {
      await db
        .update(components)
        .set({ devServerPort: port, devServerPid: pid, updatedAt: new Date() })
        .where(eq(components.id, input.componentId));
    }

    screenshotPath = await deps.visualCapture.screenshot({ port, worktreePath: input.worktreePath });
  }

  // Written pending, with no thread yet, *before* the Slack post — matching
  // the ordering startup reconciliation (module 6) expects to find and repair
  // if the process dies between this insert and the update below.
  const [checkpoint] = await db
    .insert(checkpoints)
    .values({
      componentId: input.componentId,
      question: input.question,
      options: input.options ?? null,
      screenshotPath,
    })
    .returning();

  const { slackThreadTs, slackChannel } = await deps.notifier.postCheckpoint({
    componentId: input.componentId,
    question: input.question,
    options: input.options,
    screenshotPath,
  });

  await db.update(checkpoints).set({ slackThreadTs, slackChannel }).where(eq(checkpoints.id, checkpoint.id));

  await db
    .update(components)
    .set({ status: "awaiting_input", updatedAt: new Date() })
    .where(eq(components.id, input.componentId));

  return {
    status: "paused",
    message:
      "Question posted. Stop here — do not call ask_human again for this question, and do not take further action. " +
      "Their answer will arrive as your next message once they reply, whenever that is.",
    checkpointId: checkpoint.id,
  };
}
