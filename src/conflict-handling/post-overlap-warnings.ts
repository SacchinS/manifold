import { db } from "../db/index.js";
import { decisionLog } from "../db/schema.js";
import type { Notifier } from "../notifier/types.js";
import type { FileOverlapWarning } from "./check-file-overlap.js";

export interface PostOverlapWarningsDeps {
  notifier: Notifier;
}

// A warning, not a pause — per manifold-handoff.md module 7, this may well
// be a false positive from an imperfect initial split, so it never touches
// component status or blocks anything. Logged to decision_log for both
// components involved so it shows up in either one's PR summary.
export async function postOverlapWarnings(
  completingComponentId: number,
  warnings: FileOverlapWarning[],
  deps: PostOverlapWarningsDeps,
): Promise<void> {
  for (const warning of warnings) {
    const territory = warning.matchType === "declared_owned_paths" ? "declared owned_paths" : "own changes";
    const message = `Component ${completingComponentId} just finished touching ${warning.overlappingFiles.join(", ")}, which overlaps with component ${warning.otherComponentId}'s ${territory}. This may be a false positive from an imperfect initial split — no action is being taken automatically.`;

    await deps.notifier.postWarning({ message });

    await db.insert(decisionLog).values([
      { componentId: completingComponentId, entryType: "conflict_event", content: message },
      { componentId: warning.otherComponentId, entryType: "conflict_event", content: message },
    ]);
  }
}
