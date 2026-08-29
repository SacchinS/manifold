export interface LaunchInput {
  componentId: number;
  branchName: string;
  worktreePath: string;
  taskDescription: string;
  ownedPaths: string[];
}

export interface LaunchResult {
  sessionId: string;
}

// Satisfied for real by code that starts a fresh branch agent process — a
// live Claude Agent SDK session in the component's worktree with the
// ask_human tool registered (module 4 in manifold-handoff.md). Kept behind
// an interface so the scheduler (module 2) can be built and tested before
// real SDK access is wired in.
export interface ComponentLauncher {
  launch(input: LaunchInput): Promise<LaunchResult>;
}
