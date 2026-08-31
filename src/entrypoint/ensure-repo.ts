import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

export interface EnsureRepoResult {
  repoCreated: boolean;
}

// Module 1, step 1 in manifold-handoff.md: "If repo doesn't exist, create
// it via Octokit. If it exists, pull the file tree and recent commit
// history." Uses the gh CLI rather than Octokit directly, same reasoning as
// RealGitHubClient — it's already authenticated here. A freshly created
// repo gets an initial README commit (--add-readme) so it has a real
// default branch to clone and branch worktrees off of — an empty repo with
// no commits at all can't be worked against.
export async function ensureTargetRepo(targetRepo: string): Promise<EnsureRepoResult> {
  try {
    await execFile("gh", ["repo", "view", targetRepo]);
    return { repoCreated: false };
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    const genuinelyMissing = /Could not resolve to a Repository/i.test(stderr) || /HTTP 404/.test(stderr);

    if (!genuinelyMissing) {
      // The check itself failed for some other reason (network blip,
      // timeout, resource pressure) — assuming "doesn't exist" here would
      // risk trying to create a repo that's already there, which either
      // fails loudly (harmless) or, worse, silently races with it. Surface
      // the real error instead of guessing.
      throw new Error(
        `Could not determine whether ${targetRepo} exists (this wasn't a "repository not found" error) — not attempting to create it. Underlying error: ${stderr || (err as Error).message}`,
      );
    }

    console.log(`Repo ${targetRepo} doesn't exist yet — creating it.`);
    await execFile("gh", ["repo", "create", targetRepo, "--private", "--add-readme"]);
    return { repoCreated: true };
  }
}
