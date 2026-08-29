import type { SummaryDocInput, SummaryWriter } from "./types.js";

// Deterministic placeholder for the real summary writer, which will ask the
// component's own Claude Agent SDK session to produce this doc. Good enough
// to exercise everything downstream of it (PR creation, status transitions)
// without needing a live session.
export class StubSummaryWriter implements SummaryWriter {
  async writeSummaryDoc(input: SummaryDocInput): Promise<string> {
    const decisions = input.decisionLogEntries.length
      ? input.decisionLogEntries.map((e) => `- [${e.entryType}] ${e.content.replace(/\n/g, " ")}`).join("\n")
      : "- No decisions recorded.";

    return [
      `# ${input.taskDescription}`,
      "",
      "## Implementation approach",
      "(stub — real writer will have the branch agent describe its approach here)",
      "",
      "## Decisions made",
      decisions,
      "",
      "## Known limitations",
      "(stub — real writer will have the branch agent note limitations here)",
    ].join("\n");
  }
}
