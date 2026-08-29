import type { ComponentLauncher, LaunchInput, LaunchResult } from "./types.js";

export class StubComponentLauncher implements ComponentLauncher {
  async launch(input: LaunchInput): Promise<LaunchResult> {
    const sessionId = `stub-session-${input.componentId}-${Date.now()}`;
    console.log(
      `[stub-launch] would launch branch agent for component ${input.componentId} on branch "${input.branchName}" (session ${sessionId})`,
    );
    return { sessionId };
  }
}
