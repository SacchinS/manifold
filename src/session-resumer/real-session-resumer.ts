import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { components } from "../db/schema.js";
import { runBranchAgent, type RunBranchAgentDeps } from "../branch-agent/runner.js";
import type { ResumeInput, SessionResumer } from "./types.js";

// ResumeInput (module 5's interface) doesn't carry worktreePath — the
// checkpoint/resolve flow never needed it before now — so this looks the
// component's worktree up itself rather than widening that interface for
// one caller.
export class RealSessionResumer implements SessionResumer {
  constructor(private readonly deps: RunBranchAgentDeps) {}

  async resume(input: ResumeInput): Promise<void> {
    const [component] = await db.select().from(components).where(eq(components.id, input.componentId));
    if (!component) throw new Error(`component ${input.componentId} not found`);

    await runBranchAgent(
      {
        mode: "resume",
        componentId: input.componentId,
        worktreePath: component.worktreePath,
        sessionId: input.sessionId,
        answer: input.answer,
      },
      this.deps,
    );
  }
}
