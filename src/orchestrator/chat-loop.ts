import { query } from "@anthropic-ai/claude-agent-sdk";
import { createOrchestratorTools, ORCHESTRATOR_TOOL_NAMES } from "./tools.js";
import { buildOrchestratorSystemPromptAppend } from "./system-prompt.js";
import { hasCycle } from "../scheduler/dag.js";
import type { Plan } from "./plan-schema.js";

const READ_ONLY_TOOLS = ["Read", "Glob", "Grep"];

export interface OrchestratorChatDeps {
  baseRepoPath: string;
  /** Reads the human's next reply. The real CLI uses readline/stdin; tests supply canned answers. */
  getHumanInput: () => Promise<string>;
  /** Displays the orchestrator's reply. The real CLI uses console.log; tests can capture it. */
  print: (text: string) => void;
}

// Module 1 in manifold-handoff.md: a plain synchronous chat loop, deliberately
// not backed by checkpoints or any DB row — the human is live and present,
// so there's nothing here that needs to survive a process restart. Loops
// until the orchestrator itself calls finalize_plan, which it's instructed
// to do only once it judges the human has approved. A finalized plan with a
// dependency cycle is rejected without ever bothering the human — the error
// goes straight back to the orchestrator as the next message.
export async function runOrchestratorChat(featureDescription: string, deps: OrchestratorChatDeps): Promise<Plan> {
  let finalizedPlan: Plan | null = null;
  const tools = createOrchestratorTools((plan) => {
    finalizedPlan = plan;
  });

  const baseOptions = {
    cwd: deps.baseRepoPath,
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    allowedTools: [...READ_ONLY_TOOLS, ...ORCHESTRATOR_TOOL_NAMES],
    mcpServers: { orchestrator: tools },
  };

  let sessionId: string | undefined;
  let nextPrompt = "Begin. Inspect the repository and propose an initial component breakdown for this feature.";
  let isFirstTurn = true;

  while (!finalizedPlan) {
    const q = isFirstTurn
      ? query({
          prompt: nextPrompt,
          options: {
            ...baseOptions,
            systemPrompt: {
              type: "preset" as const,
              preset: "claude_code" as const,
              append: buildOrchestratorSystemPromptAppend({ featureDescription }),
            },
          },
        })
      : query({ prompt: nextPrompt, options: { ...baseOptions, resume: sessionId! } });
    isFirstTurn = false;

    for await (const message of q) {
      if (message.type === "system" && message.subtype === "init") sessionId = message.session_id;
      if (message.type === "result") sessionId = message.session_id;
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text" && block.text.trim()) deps.print(block.text);
        }
      }
    }

    if (finalizedPlan) {
      const plan: Plan = finalizedPlan;
      if (hasCycle(plan.components.map((c) => ({ id: c.id, dependsOn: c.dependsOn })))) {
        finalizedPlan = null;
        nextPrompt =
          "That plan has a dependency cycle (some component depends, directly or indirectly, on itself). " +
          "Fix the dependencies and call finalize_plan again. Do not show this to the human first — just fix it.";
        continue;
      }
      break;
    }

    nextPrompt = await deps.getHumanInput();
  }

  return finalizedPlan!;
}
