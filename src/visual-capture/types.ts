export interface EnsureDevServerInput {
  worktreePath: string;
  existingPort?: number | null;
  existingPid?: number | null;
}

export interface EnsureDevServerResult {
  port: number;
  pid: number;
}

export interface ScreenshotInput {
  port: number;
  worktreePath: string;
}

// Satisfied for real by a Playwright-backed implementation (module 4 in
// manifold-handoff.md: boot the worktree's dev server, screenshot the
// relevant view). ask_human depends only on this interface.
export interface VisualCapture {
  ensureDevServer(input: EnsureDevServerInput): Promise<EnsureDevServerResult>;
  screenshot(input: ScreenshotInput): Promise<string>;
}
