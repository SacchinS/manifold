import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { minimatch } from "minimatch";

const execFile = promisify(execFileCb);

// Components still in flight — anything that hasn't fully landed or been
// dropped. A merged or abandoned component's territory is no longer live,
// so it can't conflict with anything.
const IN_FLIGHT_STATUSES = new Set([
  "blocked_on_deps",
  "in_progress",
  "awaiting_input",
  "ready_for_pr",
  "pr_open",
  "conflict_paused",
  "usage_paused",
]);

export interface ComponentForOverlapCheck {
  id: number;
  branchName: string;
  ownedPaths: string[];
  status: string;
}

export interface FileOverlapWarning {
  otherComponentId: number;
  overlappingFiles: string[];
  matchType: "declared_owned_paths" | "actual_branch_diff";
}

// Module 7, path 2 in manifold-handoff.md. Diffs the completing component's
// changed files against every other still-in-flight component's declared
// owned_paths (their claimed territory, whether or not they've written
// there yet) and against those components' own actual committed diffs
// (real simultaneous edits, regardless of declared ownership). This reads
// branches' committed history via the base repo, not live worktree state —
// a deliberate simplification since branch agents are expected to commit
// their work rather than leave it sitting uncommitted.
export async function checkFileOverlap(
  completingComponent: ComponentForOverlapCheck,
  otherComponents: ComponentForOverlapCheck[],
  baseRepoPath: string,
  baseBranch = "main",
): Promise<FileOverlapWarning[]> {
  const changedFiles = await getChangedFiles(baseRepoPath, completingComponent.branchName, baseBranch);
  const warnings: FileOverlapWarning[] = [];

  for (const other of otherComponents) {
    if (other.id === completingComponent.id) continue;
    if (!IN_FLIGHT_STATUSES.has(other.status)) continue;

    const declaredMatches = changedFiles.filter((file) => other.ownedPaths.some((pattern) => minimatch(file, pattern)));
    if (declaredMatches.length) {
      warnings.push({ otherComponentId: other.id, overlappingFiles: declaredMatches, matchType: "declared_owned_paths" });
    }

    let otherChangedFiles: string[];
    try {
      otherChangedFiles = await getChangedFiles(baseRepoPath, other.branchName, baseBranch);
    } catch {
      continue; // other branch has no commits relative to base yet — nothing to compare.
    }
    const actualMatches = changedFiles.filter((file) => otherChangedFiles.includes(file));
    if (actualMatches.length) {
      warnings.push({ otherComponentId: other.id, overlappingFiles: actualMatches, matchType: "actual_branch_diff" });
    }
  }

  return warnings;
}

async function getChangedFiles(baseRepoPath: string, branchName: string, baseBranch: string): Promise<string[]> {
  const { stdout } = await execFile("git", ["diff", "--name-only", `${baseBranch}...${branchName}`], {
    cwd: baseRepoPath,
  });
  return stdout.split("\n").filter(Boolean);
}
