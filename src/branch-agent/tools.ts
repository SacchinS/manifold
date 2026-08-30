import { z } from "zod";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { components, decisionLog } from "../db/schema.js";
import { askHuman, type AskHumanDeps } from "./ask-human.js";

export interface BranchAgentToolContext {
  componentId: number;
  worktreePath: string;
}

// The three custom tools a branch agent gets, on top of the standard
// file/bash tools the runner grants separately (module 4 in
// manifold-handoff.md). All three close over componentId/worktreePath
// rather than taking them as tool arguments — the agent shouldn't need to
// know or repeat its own component id.
//
// onStatusChange fires whenever ask_human or mark_ready_for_pr writes
// components.status — the runner uses it to know whether it needs to set a
// final status itself when the query ends (see runner.ts): if neither tool
// fired during a run, nothing else will have moved the component off
// whatever paused status it resumed from.
export function createBranchAgentTools(context: BranchAgentToolContext, deps: AskHumanDeps, onStatusChange: () => void) {
  const askHumanTool = tool(
    "ask_human",
    "Ask the human a question and pause this component until they answer. Call this at most once per question — after calling it, stop and take no further action; their answer arrives as your next message whenever they reply. Use before finalizing any public interface, schema, or anything visual/UX-related, or when genuinely uncertain between meaningfully different options.",
    {
      question: z.string().describe("The question to ask"),
      options: z.array(z.string()).optional().describe("Suggested answer options, if there are natural discrete choices"),
      is_visual: z.boolean().optional().describe("True if this needs a screenshot of the current UI state to answer well"),
    },
    async ({ question, options, is_visual }) => {
      const result = await askHuman(
        { componentId: context.componentId, worktreePath: context.worktreePath, question, options, isVisual: is_visual },
        deps,
      );
      onStatusChange();
      return { content: [{ type: "text" as const, text: result.message }] };
    },
  );

  const logDecisionTool = tool(
    "log_decision",
    "Record an autonomous decision you made on your own (naming, internal structure, library choice with no external effect, minor refactors) without needing to stop and ask. Call this as you make such decisions, don't batch them up.",
    {
      summary: z.string().describe("One or two sentences: what you decided and why"),
    },
    async ({ summary }) => {
      await db.insert(decisionLog).values({
        componentId: context.componentId,
        entryType: "autonomous_decision",
        content: summary,
      });
      return { content: [{ type: "text" as const, text: "logged" }] };
    },
  );

  const markReadyForPrTool = tool(
    "mark_ready_for_pr",
    "Call this once, when your assigned work is complete, committed, and ready for a PR to be opened. Do not call it before your changes are actually committed.",
    {},
    async () => {
      await db
        .update(components)
        .set({ status: "ready_for_pr", updatedAt: new Date() })
        .where(eq(components.id, context.componentId));
      onStatusChange();
      return { content: [{ type: "text" as const, text: "marked ready_for_pr" }] };
    },
  );

  return createSdkMcpServer({
    name: "manifold",
    tools: [askHumanTool, logDecisionTool, markReadyForPrTool],
  });
}

export const BRANCH_AGENT_TOOL_NAMES = [
  "mcp__manifold__ask_human",
  "mcp__manifold__log_decision",
  "mcp__manifold__mark_ready_for_pr",
];
