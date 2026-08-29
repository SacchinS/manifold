import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { components } from "../db/schema.js";
import { removeWorktree } from "../worktree/manager.js";
import { schedulerTick, type SchedulerTickDeps } from "../scheduler/tick.js";
import type { GitHubClient } from "./types.js";

export interface PollMergesDeps {
  githubClient: GitHubClient;
  targetRepo: string;
  baseRepoPath: string;
  schedulerDeps: SchedulerTickDeps;
}

export interface PollMergesResult {
  mergedComponentIds: number[];
  newlyLaunchedComponentIds: number[];
}

// Module 8, steps 5-6 in manifold-handoff.md. Meant to run on a periodic
// timer (e.g. every few minutes) against every run's pr_open components,
// not via a GitHub webhook.
export async function pollForMerges(runId: number, deps: PollMergesDeps): Promise<PollMergesResult> {
  const openComponents = await db
    .select()
    .from(components)
    .where(and(eq(components.runId, runId), eq(components.status, "pr_open")));

  const mergedComponentIds: number[] = [];

  for (const component of openComponents) {
    if (component.prNumber === null) continue;

    const status = await deps.githubClient.getPullRequestStatus(deps.targetRepo, component.prNumber);
    if (status !== "merged") continue;

    await removeWorktree({
      baseRepoPath: deps.baseRepoPath,
      worktreePath: component.worktreePath,
      devServerPid: component.devServerPid ?? undefined,
    });

    await db.update(components).set({ status: "merged", updatedAt: new Date() }).where(eq(components.id, component.id));
    mergedComponentIds.push(component.id);
  }

  // Let the scheduler pick up any newly unblocked components (module 2).
  const newlyLaunchedComponentIds = mergedComponentIds.length
    ? await schedulerTick(runId, deps.schedulerDeps)
    : [];

  return { mergedComponentIds, newlyLaunchedComponentIds };
}
