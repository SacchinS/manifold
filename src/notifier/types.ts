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

// Satisfied for real by the Slack Bolt app (module 3 in manifold-handoff.md).
// ask_human (module 4) depends only on this interface so the real Slack
// wiring can be dropped in later without changing checkpoint logic.
export interface Notifier {
  postCheckpoint(input: PostCheckpointInput): Promise<PostCheckpointResult>;
}
