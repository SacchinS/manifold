import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { CreatePullRequestInput, CreatePullRequestResult, GitHubClient, PullRequestStatus } from "./types.js";

const execFile = promisify(execFileCb);

export interface RealGitHubClientOptions {
  /** Local repo with the remote already configured — used to push the branch before opening the PR. */
  baseRepoPath: string;
  remoteName?: string;
}

// Uses the `gh` CLI rather than Octokit directly, since it's already
// authenticated on this machine and handles auth/credential plumbing for us.
// The PR body goes through a temp file and --body-file, not an inline
// --body argument — arbitrary Markdown (backticks, quotes, newlines) is not
// safe to pass as a single shell-adjacent argument otherwise.
export class RealGitHubClient implements GitHubClient {
  constructor(private readonly options: RealGitHubClientOptions) {}

  async createPullRequest(input: CreatePullRequestInput): Promise<CreatePullRequestResult> {
    const remote = this.options.remoteName ?? "origin";
    await execFile("git", ["push", remote, input.branchName], { cwd: this.options.baseRepoPath });

    const bodyPath = path.join(tmpdir(), `manifold-pr-body-${randomUUID()}.md`);
    await writeFile(bodyPath, input.body);
    try {
      const { stdout } = await execFile(
        "gh",
        [
          "pr",
          "create",
          "--repo",
          input.targetRepo,
          "--head",
          input.branchName,
          "--base",
          input.baseBranch,
          "--title",
          input.title,
          "--body-file",
          bodyPath,
        ],
        { cwd: this.options.baseRepoPath },
      );
      const url = stdout.trim().split("\n").pop() ?? "";
      const match = url.match(/\/pull\/(\d+)/);
      if (!match) throw new Error(`could not parse a PR number out of gh pr create's output: ${stdout}`);
      return { prNumber: Number(match[1]) };
    } finally {
      await unlink(bodyPath).catch(() => {});
    }
  }

  async getPullRequestStatus(targetRepo: string, prNumber: number): Promise<PullRequestStatus> {
    const { stdout } = await execFile("gh", ["pr", "view", String(prNumber), "--repo", targetRepo, "--json", "state"], {
      cwd: this.options.baseRepoPath,
    });
    const { state } = JSON.parse(stdout) as { state: string };
    const normalized = state.toLowerCase();
    if (normalized === "open" || normalized === "merged" || normalized === "closed") return normalized;
    throw new Error(`unexpected PR state from gh: "${state}"`);
  }
}
