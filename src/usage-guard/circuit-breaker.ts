export interface RunStats {
  /** Elapsed wall-clock time since this continuous agent run started. */
  elapsedMs: number;
  /** Assistant turns taken so far in this continuous run. */
  turnCount: number;
}

export interface RateLimitReading {
  /** False for API-key/Bedrock/Vertex sessions, or when the account has no plan limits to report. */
  available: boolean;
  /** 0-100, or null if the server didn't report a number. */
  fiveHourUtilization: number | null;
  resetsAt: string | null;
}

export type CircuitBreakerAction =
  | { type: "continue" }
  | { type: "warn"; reason: "usage_high"; utilization: number; resetsAt: string | null }
  | { type: "graceful_stop"; reason: "runaway" | "usage_critical"; detail: string };

// A local run that's gone on this long, or taken this many turns, without
// finishing or pausing on its own, is treated as stuck regardless of
// whether the usage API is even available — this tripwire never depends on
// the experimental rate-limit reading, so it still protects against a
// runaway agent if that API ever changes or is removed.
export const RUNAWAY_CEILING_MS = 45 * 60 * 1000;
export const RUNAWAY_CEILING_TURNS = 60;

// Thresholds against the account's actual rolling 5-hour window utilization
// (module 8.5 in manifold-handoff.md — usage guard). Warn early enough that
// posting a Slack notice is useful; force-stop with enough headroom left
// that an agent has time to reach a clean commit before the wall hits.
export const USAGE_WARN_THRESHOLD = 85;
export const USAGE_FORCE_STOP_THRESHOLD = 95;

// Pure decision function — no I/O, no SDK dependency, deliberately testable
// with plain fixtures. Runaway is checked first because it's always
// meaningful; the usage-based checks only apply when the experimental API
// actually returned a number for this account.
export function evaluateCircuitBreaker(stats: RunStats, rateLimit: RateLimitReading): CircuitBreakerAction {
  if (stats.elapsedMs >= RUNAWAY_CEILING_MS || stats.turnCount >= RUNAWAY_CEILING_TURNS) {
    return {
      type: "graceful_stop",
      reason: "runaway",
      detail: `run has taken ${Math.round(stats.elapsedMs / 60000)} min and ${stats.turnCount} turns with no pause or completion`,
    };
  }

  if (rateLimit.available && rateLimit.fiveHourUtilization !== null) {
    if (rateLimit.fiveHourUtilization >= USAGE_FORCE_STOP_THRESHOLD) {
      return {
        type: "graceful_stop",
        reason: "usage_critical",
        detail: `5-hour usage window at ${rateLimit.fiveHourUtilization}% (resets ${rateLimit.resetsAt ?? "unknown"})`,
      };
    }
    if (rateLimit.fiveHourUtilization >= USAGE_WARN_THRESHOLD) {
      return {
        type: "warn",
        reason: "usage_high",
        utilization: rateLimit.fiveHourUtilization,
        resetsAt: rateLimit.resetsAt,
      };
    }
  }

  return { type: "continue" };
}
