export interface ResumeInput {
  componentId: number;
  sessionId: string;
  answer: string;
}

// Satisfied for real by code that launches a fresh short-lived process
// running the Claude Agent SDK with `resume: sessionId` and the answer as
// the next user message (module 4/5 in manifold-handoff.md — the core-risk
// mechanic). Kept behind an interface so checkpoint resolution (module 5)
// can be built and tested before real SDK access is wired in.
export interface SessionResumer {
  resume(input: ResumeInput): Promise<void>;
}
