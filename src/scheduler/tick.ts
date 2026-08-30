import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { components } from "../db/schema.js";
import { addWorktree } from "../worktree/manager.js";
import type { ComponentLauncher } from "../component-launcher/types.js";
import { findLaunchableComponents } from "./scheduler.js";
import { shouldPauseNewLaunches, getLatestUtilization } from "../usage-guard/rate-limit-cache.js";

export interface SchedulerTickDeps {
  baseRepoPath: string;
  launcher: ComponentLauncher;
}

// Runs one scheduling pass for a run: finds components whose dependencies
// have all merged, creates their worktrees, and launches their branch
// agents. Returns the ids of components launched this pass.
//
// Starting new work while the account is already near its shared usage
// ceiling (module 8.5, usage guard) is counterproductive — it competes with
// whatever's already running, and with the human's own interactive use, for
// the same budget. When the most recent reading says utilization is high,
// this tick launches nothing at all and leaves everything blocked_on_deps
// to be picked up on a later tick once usage drops.
export async function schedulerTick(runId: number, deps: SchedulerTickDeps): Promise<number[]> {
  if (shouldPauseNewLaunches()) {
    const snapshot = getLatestUtilization();
    console.log(
      `[scheduler] holding all new launches for run ${runId}: usage at ${snapshot?.utilization}% (resets ${snapshot?.resetsAt ?? "unknown"})`,
    );
    return [];
  }

  const runComponents = await db.select().from(components).where(eq(components.runId, runId));

  const launchableIds = findLaunchableComponents(
    runComponents.map((c) => ({ id: c.id, status: c.status, dependsOn: c.dependsOn })),
  );

  for (const id of launchableIds) {
    const component = runComponents.find((c) => c.id === id)!;

    await addWorktree({
      baseRepoPath: deps.baseRepoPath,
      worktreePath: component.worktreePath,
      branchName: component.branchName,
    });

    const { sessionId } = await deps.launcher.launch({
      componentId: component.id,
      branchName: component.branchName,
      worktreePath: component.worktreePath,
      taskDescription: component.taskDescription,
      ownedPaths: component.ownedPaths,
    });

    await db
      .update(components)
      .set({ status: "in_progress", sessionId, updatedAt: new Date() })
      .where(eq(components.id, component.id));
  }

  return launchableIds;
}
