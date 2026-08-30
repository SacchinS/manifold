import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { planComponentSchema, type Plan } from "./plan-schema.js";
import { z } from "zod";

// A single tool, deliberately. Module 1's plan negotiation is a plain
// conversation — the orchestrator just talks and revises in prose/JSON as
// part of its normal replies, since there's no DB/Slack state to write for
// a draft anyway. finalize_plan is the one moment that matters: the
// orchestrator calls it only when it judges the human has actually
// approved the current plan, not on every round.
export function createOrchestratorTools(onFinalize: (plan: Plan) => void) {
  const finalizePlanTool = tool(
    "finalize_plan",
    "Call this exactly once, only when the human has clearly approved the current plan. Do not call it while still negotiating or revising.",
    {
      components: z.array(planComponentSchema),
    },
    async ({ components }) => {
      onFinalize({ components });
      return { content: [{ type: "text" as const, text: "plan finalized" }] };
    },
  );

  return createSdkMcpServer({ name: "orchestrator", tools: [finalizePlanTool] });
}

export const ORCHESTRATOR_TOOL_NAMES = ["mcp__orchestrator__finalize_plan"];
