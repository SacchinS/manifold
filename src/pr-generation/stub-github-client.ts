import type { CreatePullRequestInput, CreatePullRequestResult, GitHubClient, PullRequestStatus } from "./types.js";

// Stub stand-in for Octokit / `gh pr create`. Statuses are set manually via
// `setStatus` so tests can simulate a PR being merged between polls.
export class StubGitHubClient implements GitHubClient {
  private nextPrNumber = 1;
  private statuses = new Map<number, PullRequestStatus>();

  async createPullRequest(input: CreatePullRequestInput): Promise<CreatePullRequestResult> {
    const prNumber = this.nextPrNumber++;
    this.statuses.set(prNumber, "open");
    console.log(`[stub-github] opened PR #${prNumber} for branch "${input.branchName}" -> ${input.baseBranch}`);
    console.log(`[stub-github] title: ${input.title}`);
    return { prNumber };
  }

  async getPullRequestStatus(_targetRepo: string, prNumber: number): Promise<PullRequestStatus> {
    return this.statuses.get(prNumber) ?? "open";
  }

  setStatus(prNumber: number, status: PullRequestStatus): void {
    this.statuses.set(prNumber, status);
  }
}
