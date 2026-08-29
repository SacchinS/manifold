import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { components } from "../db/schema.js";
import type { Notifier } from "../notifier/types.js";
import { checkMergeConflict } from "../conflict-handling/check-merge-conflict.js";
import { pauseForMergeConflict } from "../conflict-handling/pause-for-conflict.js";
import { checkFileOverlap } from "../conflict-handling/check-file-overlap.js";
import { postOverlapWarnings } from "../conflict-handling/post-overlap-warnings.js";
import { generatePr, type GeneratePrDeps } from "./generate-pr.js";

export interface PrepareForPrDeps extends GeneratePrDeps {
  notifier: Notifier;
  baseRepoPath: string;
}

export type PrepareForPrResult =
  | { outcome: "conflict_paused"; checkpointId: number }
  | { outcome: "pr_opened"; prNumber: number; body: string; overlapWarningCount: number };

// The gate a component passes through on its way to a PR: module 7's two
// conflict checks (merge conflict against main, cross-component file
// overlap) run first, then module 8's PR generation. A merge conflict stops
// this component here entirely (conflict_paused); a file overlap is just
// a warning and doesn't block the PR from opening.
export async function prepareForPr(componentId: number, deps: PrepareForPrDeps): Promise<PrepareForPrResult> {
  const [component] = await db.select().from(components).where(eq(components.id, componentId));
  if (!component) throw new Error(`component ${componentId} not found`);

  const conflict = await checkMergeConflict(deps.baseRepoPath, component.branchName, deps.baseBranch);
  if (conflict.hasConflict) {
    const { checkpointId } = await pauseForMergeConflict(
      componentId,
      {
        conflictDetails: conflict.conflictDetails!,
        commitsOnMainSinceBranchStart: conflict.commitsOnMainSinceBranchStart!,
      },
      { notifier: deps.notifier },
    );
    return { outcome: "conflict_paused", checkpointId };
  }

  const otherComponents = await db.select().from(components).where(eq(components.runId, component.runId));
  const overlaps = await checkFileOverlap(component, otherComponents, deps.baseRepoPath, deps.baseBranch);
  if (overlaps.length) {
    await postOverlapWarnings(componentId, overlaps, { notifier: deps.notifier });
  }

  const { prNumber, body } = await generatePr(componentId, deps);
  return { outcome: "pr_opened", prNumber, body, overlapWarningCount: overlaps.length };
}
