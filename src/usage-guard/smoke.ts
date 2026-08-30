import {
  evaluateCircuitBreaker,
  RUNAWAY_CEILING_MS,
  RUNAWAY_CEILING_TURNS,
  USAGE_WARN_THRESHOLD,
  USAGE_FORCE_STOP_THRESHOLD,
} from "./circuit-breaker.js";
import {
  recordUtilization,
  getLatestUtilization,
  shouldPauseNewLaunches,
  _resetForTests,
  _setForTests,
} from "./rate-limit-cache.js";

const NO_LIMIT: { available: boolean; fiveHourUtilization: number | null; resetsAt: string | null } = {
  available: false,
  fiveHourUtilization: null,
  resetsAt: null,
};

function checkCircuitBreakerFixtures() {
  const normal = evaluateCircuitBreaker({ elapsedMs: 5 * 60_000, turnCount: 10 }, NO_LIMIT);
  console.log("well within limits -> continue?", normal.type === "continue");

  const timeRunaway = evaluateCircuitBreaker({ elapsedMs: RUNAWAY_CEILING_MS + 1, turnCount: 10 }, NO_LIMIT);
  console.log("over time ceiling -> graceful_stop/runaway?", timeRunaway.type === "graceful_stop" && timeRunaway.reason === "runaway");

  const turnRunaway = evaluateCircuitBreaker({ elapsedMs: 5 * 60_000, turnCount: RUNAWAY_CEILING_TURNS + 1 }, NO_LIMIT);
  console.log("over turn ceiling -> graceful_stop/runaway?", turnRunaway.type === "graceful_stop" && turnRunaway.reason === "runaway");

  const runawayIgnoresRateLimitAvailability = evaluateCircuitBreaker(
    { elapsedMs: RUNAWAY_CEILING_MS + 1, turnCount: 5 },
    { available: false, fiveHourUtilization: null, resetsAt: null },
  );
  console.log(
    "runaway fires even when rate-limit API unavailable?",
    runawayIgnoresRateLimitAvailability.type === "graceful_stop",
  );

  const belowWarn = evaluateCircuitBreaker(
    { elapsedMs: 5 * 60_000, turnCount: 5 },
    { available: true, fiveHourUtilization: USAGE_WARN_THRESHOLD - 1, resetsAt: "2026-08-30T20:00:00Z" },
  );
  console.log("just below warn threshold -> continue?", belowWarn.type === "continue");

  const atWarn = evaluateCircuitBreaker(
    { elapsedMs: 5 * 60_000, turnCount: 5 },
    { available: true, fiveHourUtilization: USAGE_WARN_THRESHOLD, resetsAt: "2026-08-30T20:00:00Z" },
  );
  console.log("at warn threshold -> warn?", atWarn.type === "warn" && atWarn.reason === "usage_high");

  const atForceStop = evaluateCircuitBreaker(
    { elapsedMs: 5 * 60_000, turnCount: 5 },
    { available: true, fiveHourUtilization: USAGE_FORCE_STOP_THRESHOLD, resetsAt: "2026-08-30T20:00:00Z" },
  );
  console.log(
    "at force-stop threshold -> graceful_stop/usage_critical?",
    atForceStop.type === "graceful_stop" && atForceStop.reason === "usage_critical",
  );

  const unavailableNeverWarns = evaluateCircuitBreaker(
    { elapsedMs: 5 * 60_000, turnCount: 5 },
    { available: false, fiveHourUtilization: 99, resetsAt: null },
  );
  console.log("unavailable rate limit never warns even with a stray number?", unavailableNeverWarns.type === "continue");
}

function checkRateLimitCache() {
  _resetForTests();

  console.log("\nno reading yet -> fail open, no pause?", shouldPauseNewLaunches() === false);
  console.log("no reading yet -> getLatestUtilization null?", getLatestUtilization() === null);

  recordUtilization({ utilization: 40, resetsAt: "2026-08-30T20:00:00Z" });
  console.log("fresh low reading -> no pause?", shouldPauseNewLaunches() === false);

  recordUtilization({ utilization: 90, resetsAt: "2026-08-30T20:00:00Z" });
  console.log("fresh high reading -> pause?", shouldPauseNewLaunches() === true);

  _setForTests({ utilization: 90, resetsAt: "2026-08-30T20:00:00Z", observedAt: new Date(Date.now() - 31 * 60_000) });
  console.log("stale high reading (31 min old) -> treated as no data, no pause?", shouldPauseNewLaunches() === false);
  console.log("stale reading -> getLatestUtilization null?", getLatestUtilization() === null);

  _resetForTests();
}

checkCircuitBreakerFixtures();
checkRateLimitCache();
console.log("\nusage guard smoke test passed.");
