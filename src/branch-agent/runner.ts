import { query } from "@anthropic-ai/claude-agent-sdk";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { components } from "../db/schema.js";
import { createBranchAgentTools, BRANCH_AGENT_TOOL_NAMES } from "./tools.js";
import { buildBranchAgentSystemPromptAppend } from "./system-prompt.js";
import type { AskHumanDeps } from "./ask-human.js";
import { evaluateCircuitBreaker, type RunStats, type RateLimitReading, type CircuitBreakerAction } from "../usage-guard/circuit-breaker.js";
import { recordUtilization } from "../usage-guard/rate-limit-cache.js";
import { pauseForRunaway } from "../usage-guard/pause-for-runaway.js";
import type { Notifier } from "../notifier/types.js";

const STANDARD_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep"];
const USAGE_CHECK_EVERY_N_TURNS = 5;

export type RunBranchAgentInput =
  | { mode: "launch"; componentId: number; worktreePath: string; taskDescription: string; ownedPaths: string[] }
  | { mode: "resume"; componentId: number; worktreePath: string; sessionId: string; answer: string };

export interface RunBranchAgentDeps extends AskHumanDeps {
  notifier: Notifier;
}

export interface RunBranchAgentResult {
  sessionId: string;
  // ask_human and mark_ready_for_pr already update components.status
  // themselves as part of handling their own tool call — this outcome is
  // purely informational for the caller (e.g. for logging), never something
  // a caller should use to decide what status to write, since "stopped"
  // (usage_paused) and "completed" both leave the DB already correct.
  outcome: "stopped" | "completed";
}

// Module 4's real process, module 4/5's core pause-resume mechanic wired to
// a live SDK session, and the usage guard's circuit breaker, all in one
// place: a single continuous query() run, checked periodically as it
// streams. Every call to this function corresponds to one bounded run of
// the underlying Claude Code CLI subprocess — it starts, does work, and the
// subprocess exits when this function returns, whether that's because the
// agent paused itself (ask_human), finished (mark_ready_for_pr already
// flipped status, the model just stops talking), or the circuit breaker
// force-closed it.
export async function runBranchAgent(input: RunBranchAgentInput, deps: RunBranchAgentDeps): Promise<RunBranchAgentResult> {
  let statusChangedByTool = false;
  const tools = createBranchAgentTools({ componentId: input.componentId, worktreePath: input.worktreePath }, deps, () => {
    statusChangedByTool = true;
  });

  const baseOptions = {
    cwd: input.worktreePath,
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    allowedTools: [...STANDARD_TOOLS, ...BRANCH_AGENT_TOOL_NAMES],
    mcpServers: { manifold: tools },
  };

  const q =
    input.mode === "launch"
      ? query({
          prompt: "Begin work on your assigned component now.",
          options: {
            ...baseOptions,
            systemPrompt: {
              type: "preset" as const,
              preset: "claude_code" as const,
              append: buildBranchAgentSystemPromptAppend({
                taskDescription: input.taskDescription,
                ownedPaths: input.ownedPaths,
              }),
            },
          },
        })
      : query({
          prompt: input.answer,
          options: { ...baseOptions, resume: input.sessionId },
        });

  const startedAt = Date.now();
  let turnCount = 0;
  let sessionId: string | undefined = input.mode === "resume" ? input.sessionId : undefined;
  let warnedThisRun = false;
  let stoppedForRunaway: (CircuitBreakerAction & { type: "graceful_stop" }) | null = null;

  for await (const message of q) {
    if (process.env.MANIFOLD_RUNNER_DEBUG) {
      console.error(`[runner-debug] ${message.type}${"subtype" in message ? `/${message.subtype}` : ""}`);
    }
    // Captured as early as possible (the very first message of the stream)
    // rather than only from the terminal result message — a force-close
    // below never produces a result message, so this is the only reliable
    // source of the id for a run that gets stopped by the circuit breaker
    // before it would otherwise have paused or finished on its own.
    if (message.type === "system" && message.subtype === "init") {
      sessionId = message.session_id;
    }
    if (message.type === "result") {
      sessionId = message.session_id;
    }

    if (message.type === "assistant") {
      turnCount++;

      if (turnCount % USAGE_CHECK_EVERY_N_TURNS === 0) {
        const stats: RunStats = { elapsedMs: Date.now() - startedAt, turnCount };
        let reading: RateLimitReading = { available: false, fiveHourUtilization: null, resetsAt: null };

        try {
          const usage = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
          reading = {
            available: usage.rate_limits_available,
            fiveHourUtilization: usage.rate_limits?.five_hour?.utilization ?? null,
            resetsAt: usage.rate_limits?.five_hour?.resets_at ?? null,
          };
          if (reading.available) {
            recordUtilization({ utilization: reading.fiveHourUtilization, resetsAt: reading.resetsAt });
          }
        } catch {
          // Experimental API — degrade to the local runaway check alone if
          // it errors or its shape ever changes.
        }

        const action = evaluateCircuitBreaker(stats, reading);
        if (action.type === "warn" && !warnedThisRun) {
          warnedThisRun = true;
          await deps.notifier.postWarning({
            message: `Component ${input.componentId} is still running with your shared usage window at ${action.utilization}% (resets ${action.resetsAt ?? "unknown"}).`,
          });
        } else if (action.type === "graceful_stop") {
          stoppedForRunaway = action;
          q.close();
          break;
        }
      }
    }
  }

  if (!sessionId) {
    throw new Error(`branch agent run for component ${input.componentId} ended without ever producing a session_id`);
  }

  if (stoppedForRunaway) {
    await pauseForRunaway(input.componentId, stoppedForRunaway, { notifier: deps.notifier });
    return { sessionId, outcome: "stopped" };
  }

  // The query ended on its own — no circuit-breaker stop. If ask_human or
  // mark_ready_for_pr already wrote a status during this run, that's the
  // real, authoritative outcome and must be left alone. If neither fired
  // (the agent just finished talking without pausing or signaling done),
  // nothing else will ever move the component off whatever status it had
  // when this run started — for a resume that's the old paused status,
  // which is now stale since the human's answer has been delivered and
  // acted on, so it needs to become in_progress here. For a launch it's
  // already in_progress from the scheduler's pre-write, so this is a
  // harmless no-op write of the same value.
  if (!statusChangedByTool) {
    await db.update(components).set({ status: "in_progress", updatedAt: new Date() }).where(eq(components.id, input.componentId));
  }

  return { sessionId, outcome: "completed" };
}
