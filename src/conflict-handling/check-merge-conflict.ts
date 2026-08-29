import { execFile as execFileCb } from "node:child_process";

// A dedicated exec helper, rather than the worktree manager's, because here
// a non-zero exit code is expected, meaningful data (a conflict) — not an
// exceptional failure to propagate as a thrown error.
function execGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    execFileCb("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code !== "number") {
        reject(error); // git itself failed to run, not just a non-zero exit
        return;
      }
      resolve({ stdout, stderr, code: error ? ((error as { code: number }).code ?? 1) : 0 });
    });
  });
}

export interface MergeConflictCheckResult {
  hasConflict: boolean;
  conflictDetails?: string;
  commitsOnMainSinceBranchStart?: string[];
}

// Module 7 in manifold-handoff.md, path 1. Uses `git merge-tree`, a plumbing
// command that computes what a merge would produce without touching any
// worktree or ref — no scratch worktree needed, and it works even after the
// component's own worktree has already been removed, since it only needs
// the branch ref to still exist in the base repo.
export async function checkMergeConflict(
  baseRepoPath: string,
  branchName: string,
  baseBranch = "main",
): Promise<MergeConflictCheckResult> {
  const mergeBaseResult = await execGit(["merge-base", baseBranch, branchName], baseRepoPath);
  if (mergeBaseResult.code !== 0) {
    throw new Error(`could not find merge base of ${baseBranch} and ${branchName}: ${mergeBaseResult.stderr}`);
  }
  const mergeBaseSha = mergeBaseResult.stdout.trim();

  const mergeTreeResult = await execGit(["merge-tree", "--write-tree", baseBranch, branchName], baseRepoPath);
  if (mergeTreeResult.code === 0) {
    return { hasConflict: false };
  }

  const logResult = await execGit(["log", "--oneline", `${mergeBaseSha}..${baseBranch}`], baseRepoPath);
  const commitsOnMainSinceBranchStart = logResult.stdout.split("\n").filter(Boolean);

  return {
    hasConflict: true,
    conflictDetails: mergeTreeResult.stdout,
    commitsOnMainSinceBranchStart,
  };
}
