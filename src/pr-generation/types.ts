export interface DecisionLogEntryForSummary {
  entryType: string;
  content: string;
  createdAt: Date;
}

export interface SummaryDocInput {
  taskDescription: string;
  decisionLogEntries: DecisionLogEntryForSummary[];
}

// Satisfied for real by a call back into the component's Claude Agent SDK
// session asking it to write the PR body (module 8 in manifold-handoff.md).
export interface SummaryWriter {
  writeSummaryDoc(input: SummaryDocInput): Promise<string>;
}

export interface CreatePullRequestInput {
  targetRepo: string;
  branchName: string;
  baseBranch: string;
  title: string;
  body: string;
}

export interface CreatePullRequestResult {
  prNumber: number;
}

export type PullRequestStatus = "open" | "merged" | "closed";

// Satisfied for real by Octokit / `gh pr create`. getPullRequestStatus is
// called on a polling cadence (module 8, step 5) rather than via webhook —
// a webhook would need a public endpoint, undercutting the reason Slack
// uses Socket Mode in this design.
export interface GitHubClient {
  createPullRequest(input: CreatePullRequestInput): Promise<CreatePullRequestResult>;
  getPullRequestStatus(targetRepo: string, prNumber: number): Promise<PullRequestStatus>;
}
