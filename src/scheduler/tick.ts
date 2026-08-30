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

  // Kick off every launchable component's worktree + branch agent
  // concurrently rather than one at a time. This matters once the launcher
  // is real: a branch agent's first run can take minutes, and a plain
  // sequential `for` loop with `await` inside it would have quietly
  // serialized every component in this tick behind whichever one happened
  // to go first — exactly the kind of bug the stub launcher's near-instant
  // resolution hid. The actual agent run is deliberately NOT awaited here;
  // `.then()`/`.catch()` below persist its outcome whenever it eventually
  // settles, however long that takes, without blocking this tick or any
  // other component's launch on it.
  await Promise.all(
    launchableIds.map(async (id) => {
      const component = runComponents.find((c) => c.id === id)!;

      await addWorktree({
        baseRepoPath: deps.baseRepoPath,
        worktreePath: component.worktreePath,
        branchName: component.branchName,
      });

      await db
        .update(components)
        .set({ status: "in_progress", updatedAt: new Date() })
        .where(eq(components.id, component.id));

      deps.launcher
        .launch({
          componentId: component.id,
          branchName: component.branchName,
          worktreePath: component.worktreePath,
          taskDescription: component.taskDescription,
          ownedPaths: component.ownedPaths,
        })
        .then(({ sessionId }) =>
          db.update(components).set({ sessionId, updatedAt: new Date() }).where(eq(components.id, component.id)),
        )
        .catch((err) => {
          console.error(`[scheduler] branch agent for component ${component.id} failed to launch:`, err);
        });
    }),
  );

  return launchableIds;
}
