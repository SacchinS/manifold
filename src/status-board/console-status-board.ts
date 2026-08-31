import { renderStatusText } from "./render.js";
import type { ComponentStatusSummary, RunStatusBoard } from "./types.js";

export class ConsoleStatusBoard implements RunStatusBoard {
  private lastRendered: string | undefined;

  async update(runId: number, components: ComponentStatusSummary[]): Promise<void> {
    const text = renderStatusText(runId, components);
    if (text === this.lastRendered) return;
    this.lastRendered = text;
    console.log(`\n${text}\n`);
  }
}
