export interface PostCheckpointInput {
  componentId: number;
  question: string;
  options?: string[] | null;
  screenshotPath?: string | null;
}

export interface PostCheckpointResult {
  slackThreadTs: string;
  slackChannel: string;
}

export interface PostWarningInput {
  message: string;
}

// Satisfied for real by the Slack Bolt app (module 3 in manifold-handoff.md).
// ask_human (module 4) depends only on postCheckpoint so the real Slack
// wiring can be dropped in later without changing checkpoint logic.
// postWarning is for non-blocking notices (module 7's cross-component file
// overlap check) — no thread tracking, no pending/resolved state, nothing
// to reply to.
export interface Notifier {
  postCheckpoint(input: PostCheckpointInput): Promise<PostCheckpointResult>;
  postWarning(input: PostWarningInput): Promise<void>;
}
