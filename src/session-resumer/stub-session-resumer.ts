import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { components } from "../db/schema.js";
import type { ResumeInput, SessionResumer } from "./types.js";

export class StubSessionResumer implements SessionResumer {
  async resume(input: ResumeInput): Promise<void> {
    console.log(
      `[stub-resume] would resume session ${input.sessionId} (component ${input.componentId}) with answer: "${input.answer}"`,
    );
    // Every SessionResumer is responsible for leaving components.status
    // correct by the time resume() returns (see resolve.ts) — a real resumer
    // gets this from the resumed run's own tool calls; this stub has no
    // real run to observe, so it just does what "resumed and still working"
    // means in the common case.
    await db
      .update(components)
      .set({ status: "in_progress", updatedAt: new Date() })
      .where(eq(components.id, input.componentId));
  }
}
