import { USAGE_WARN_THRESHOLD } from "./circuit-breaker.js";

export interface RateLimitSnapshot {
  utilization: number | null;
  resetsAt: string | null;
  observedAt: Date;
}

// The scheduler has no live query() handle of its own to check usage
// against — only running branch agents do. Rather than have the scheduler
// spin up a throwaway query just to check usage (real cost for a check that
// doesn't need to be that fresh), branch agents report their own readings
// here as they check the circuit breaker during their own runs, and the
// scheduler consults the most recent one.
//
// Deliberately in-memory, not a DB row: unlike everything else in Manifold,
// this isn't a state a human needs to resolve, so there's nothing to
// recover after a crash — a restarted process just has no reading yet and
// fails open (see shouldPauseNewLaunches), which is the right default for
// a cache with no data.
const STALE_AFTER_MS = 30 * 60 * 1000;

let latest: RateLimitSnapshot | null = null;

export function recordUtilization(reading: { utilization: number | null; resetsAt: string | null }): void {
  latest = { ...reading, observedAt: new Date() };
}

export function getLatestUtilization(): RateLimitSnapshot | null {
  if (!latest) return null;
  if (Date.now() - latest.observedAt.getTime() > STALE_AFTER_MS) return null;
  return latest;
}

// Fail-open: no reading, or a stale one, means we don't have evidence
// utilization is high, so new launches proceed. Only an actual recent
// reading at or above the warn threshold holds the scheduler back.
export function shouldPauseNewLaunches(): boolean {
  const snapshot = getLatestUtilization();
  if (!snapshot || snapshot.utilization === null) return false;
  return snapshot.utilization >= USAGE_WARN_THRESHOLD;
}

// Test-only escape hatches — there's no constructor/instance to inject a
// fresh cache through, since this is deliberately a single process-wide
// cache. _setForTests exists specifically to exercise staleness without
// needing to actually wait 30 minutes.
export function _resetForTests(): void {
  latest = null;
}

export function _setForTests(snapshot: RateLimitSnapshot): void {
  latest = snapshot;
}
