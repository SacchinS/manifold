export interface ComponentStatusSummary {
  id: number;
  taskDescription: string;
  status: string;
  branchName: string;
  prNumber: number | null;
  dependsOn: number[];
  startedAt: Date | null;
  updatedAt: Date;
}

// One board per run, updated in place (Slack's chat.update, or a re-printed
// terminal block) rather than posted as a stream of new messages — the
// point is a single artifact you can glance at for current state, not a log.
export interface RunStatusBoard {
  update(runId: number, components: ComponentStatusSummary[]): Promise<void>;
}
