import { runBranchAgent, type RunBranchAgentDeps } from "../branch-agent/runner.js";
import type { ComponentLauncher, LaunchInput, LaunchResult } from "./types.js";

export class RealComponentLauncher implements ComponentLauncher {
  constructor(private readonly deps: RunBranchAgentDeps) {}

  async launch(input: LaunchInput): Promise<LaunchResult> {
    const { sessionId } = await runBranchAgent(
      {
        mode: "launch",
        componentId: input.componentId,
        worktreePath: input.worktreePath,
        taskDescription: input.taskDescription,
        ownedPaths: input.ownedPaths,
      },
      this.deps,
    );
    return { sessionId };
  }
}
