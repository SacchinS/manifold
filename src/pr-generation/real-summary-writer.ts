import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SummaryDocInput, SummaryWriter } from "./types.js";

export interface RealSummaryWriterOptions {
  worktreePath: string;
  sessionId: string;
}

// Module 8 in manifold-handoff.md: "have the agent write a summary doc" —
// this resumes the component's own (already paused/finished) session one
// more time and asks it to write its own PR body. Deliberately lightweight:
// no custom tools registered, no circuit breaker, no status writes — this
// is just asking a question and capturing the text answer, not asking the
// agent to do more agentic work. The runner (runBranchAgent) isn't reused
// here for exactly that reason.
export class RealSummaryWriter implements SummaryWriter {
  constructor(private readonly options: RealSummaryWriterOptions) {}

  async writeSummaryDoc(input: SummaryDocInput): Promise<string> {
    const decisions = input.decisionLogEntries.length
      ? input.decisionLogEntries.map((e) => `- [${e.entryType}] ${e.content}`).join("\n")
      : "(none recorded)";

    const prompt = [
      "Your work on this component is complete. Write the PR description now, in Markdown, as your entire reply — no preamble, no tool calls.",
      "Structure it with a '## Goal' section, an '## Implementation approach' section, a '## Decisions made' section, and a '## Known limitations' section.",
      "Here is the raw decision log to draw the Decisions section from — rewrite it in your own words, don't just paste it verbatim:",
      decisions,
    ].join("\n\n");

    let text = "";
    for await (const message of query({
      prompt,
      options: { resume: this.options.sessionId, cwd: this.options.worktreePath },
    })) {
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text") text += block.text;
        }
      }
    }
    return text.trim();
  }
}
