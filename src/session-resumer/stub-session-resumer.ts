import type { ResumeInput, SessionResumer } from "./types.js";

export class StubSessionResumer implements SessionResumer {
  async resume(input: ResumeInput): Promise<void> {
    console.log(
      `[stub-resume] would resume session ${input.sessionId} (component ${input.componentId}) with answer: "${input.answer}"`,
    );
  }
}
