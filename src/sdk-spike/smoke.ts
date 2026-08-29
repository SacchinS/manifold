import "dotenv/config";
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// This is a throwaway spike, not part of Manifold's real ask_human — its only
// job is to prove the mechanic module 4/5 depend on: a session can be exited
// right after a tool call, and later resumed in a fresh query() with a plain
// new user message, without needing to fabricate a synthetic tool_result for
// the pending tool_use ourselves (the SDK's `query()` process boundary
// apparently handles that, unlike a raw Messages API loop would).

let capturedQuestion: string | null = null;

const askHumanSpike = tool(
  "ask_human",
  "Ask the human a question and pause for their answer.",
  { question: z.string() },
  async ({ question }) => {
    capturedQuestion = question;
    console.log(`\n[spike] agent asked: "${question}"`);
    console.log("[spike] tool handler returning now; process will exit right after.");
    return { content: [{ type: "text" as const, text: "paused, awaiting human input" }] };
  },
);

const spikeServer = createSdkMcpServer({ name: "manifold-spike", tools: [askHumanSpike] });

async function runFirstTurn(): Promise<string> {
  let sessionId: string | undefined;

  for await (const message of query({
    prompt:
      "Call the ask_human tool exactly once with the question 'Should the sky be blue or green?', then stop — do not say anything else after calling it.",
    options: {
      mcpServers: { "manifold-spike": spikeServer },
      allowedTools: ["mcp__manifold-spike__ask_human"],
    },
  })) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") console.log(`[spike] assistant said: ${block.text}`);
      }
    }
    if (message.type === "result") {
      sessionId = message.session_id;
    }
  }

  if (!sessionId) throw new Error("no session_id came back from the first turn");
  return sessionId;
}

async function runResumedTurn(sessionId: string): Promise<void> {
  console.log(`\n[spike] resuming session ${sessionId} in a fresh query() call with the human's answer...\n`);

  for await (const message of query({
    prompt: "The human answered: blue. Please confirm back to me in one short sentence what they said.",
    options: { resume: sessionId },
  })) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") console.log(`[spike] assistant said (after resume): ${block.text}`);
      }
    }
    if (message.type === "result") {
      console.log(`\n[spike] resumed turn finished cleanly, subtype=${message.subtype}`);
    }
  }
}

async function main() {
  console.log("=== turn 1: expect a tool call, then the process's job here is done ===");
  const sessionId = await runFirstTurn();
  console.log("\nfirst turn produced a session_id?", !!sessionId, sessionId);
  console.log("ask_human tool was actually invoked?", capturedQuestion !== null);

  console.log("\n=== turn 2: fresh query(), resume: sessionId, plain new user message ===");
  await runResumedTurn(sessionId);

  console.log("\nsdk pause/resume spike passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
