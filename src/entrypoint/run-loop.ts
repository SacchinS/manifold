import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { components, checkpoints } from "../db/schema.js";
import { schedulerTick } from "../scheduler/tick.js";
import { resolveCheckpoint } from "../checkpoints/resolve.js";
import { prepareForPr } from "../pr-generation/prepare-for-pr.js";
import { pollForMerges } from "../pr-generation/poll-merges.js";
import { RealComponentLauncher } from "../component-launcher/real-component-launcher.js";
import { RealSessionResumer } from "../session-resumer/real-session-resumer.js";
import { RealSummaryWriter } from "../pr-generation/real-summary-writer.js";
import { RealGitHubClient } from "../pr-generation/real-github-client.js";
import type { Notifier } from "../notifier/types.js";
import type { AskHumanDeps } from "../branch-agent/ask-human.js";
import type { RunStatusBoard } from "../status-board/types.js";

export interface RunLoopDeps extends AskHumanDeps {
  notifier: Notifier;
  statusBoard: RunStatusBoard;
  baseRepoPath: string;
  targetRepo: string;
  baseBranch: string;
  /**
   * Only needed when there's no real Notifier resolving checkpoints on its
   * own (the CLI's terminal stand-in from before real Slack existed). Real
   * Slack (module 3/5) resolves checkpoints itself, asynchronously, via its
   * own message listener — independent of this loop's poll cycle — so when
   * a real Notifier is in use, omit this and the checkpoint-scanning block
   * below is skipped entirely rather than racing the Slack listener to
   * resolve the same checkpoint.
   */
  getCheckpointAnswer?: (question: string, options: string[] | null | undefined) => Promise<string>;
  print: (text: string) => void;
  pollIntervalMs?: number;
}

// The piece that didn't exist yet: ties the scheduler, real branch-agent
// launches/resumes, checkpoint answering, and PR generation/merge polling
// into one continuous loop for a single run — step 11 in manifold-handoff.md.
// PR-open notices always go through deps.notifier (real Slack once
// configured); checkpoint answering goes through Slack's own listener when
// a real Notifier is wired up, or through getCheckpointAnswer as a terminal
// stand-in otherwise. Every checkpoint answer and PR-open call is fired
// without awaiting its full completion, so answering one component's
// question or opening one PR never blocks the loop from noticing another
// component's checkpoint or a merge that just landed.
export async function runManifoldLoop(runId: number, deps: RunLoopDeps): Promise<void> {
  const launcher = new RealComponentLauncher(deps);
  const schedulerDeps = { baseRepoPath: deps.baseRepoPath, launcher };

  const handledCheckpointIds = new Set<number>();
  const prRequestedComponentIds = new Set<number>();

  while (true) {
    await schedulerTick(runId, schedulerDeps);

    const runComponents = await db.select().from(components).where(eq(components.runId, runId));

    if (deps.getCheckpointAnswer) {
      const getCheckpointAnswer = deps.getCheckpointAnswer;
      for (const component of runComponents) {
        const pending = await db
          .select()
          .from(checkpoints)
          .where(and(eq(checkpoints.componentId, component.id), eq(checkpoints.status, "pending")));

        for (const checkpoint of pending) {
          if (handledCheckpointIds.has(checkpoint.id)) continue;
          handledCheckpointIds.add(checkpoint.id);

          deps.print(
            `\n[component ${component.id}] ${checkpoint.question}${checkpoint.options?.length ? ` (${checkpoint.options.join(" / ")})` : ""}`,
          );

          getCheckpointAnswer(checkpoint.question, checkpoint.options)
            .then((answer) => resolveCheckpoint(checkpoint.id, answer, { sessionResumer: new RealSessionResumer(deps) }))
            .catch((err) => console.error(`[run-loop] failed to resolve checkpoint ${checkpoint.id}:`, err));
        }
      }
    }

    for (const component of runComponents) {
      if (component.status !== "ready_for_pr" || prRequestedComponentIds.has(component.id)) continue;
      if (!component.sessionId) continue; // shouldn't happen — ready_for_pr implies a session ran
      prRequestedComponentIds.add(component.id);

      const summaryWriter = new RealSummaryWriter({ worktreePath: component.worktreePath, sessionId: component.sessionId });
      const githubClient = new RealGitHubClient({ baseRepoPath: deps.baseRepoPath });

      prepareForPr(component.id, {
        notifier: deps.notifier,
        baseRepoPath: deps.baseRepoPath,
        baseBranch: deps.baseBranch,
        summaryWriter,
        githubClient,
        targetRepo: deps.targetRepo,
      })
        .then((result) => {
          if (result.outcome === "pr_opened") {
            const message = `Component ${component.id}: PR #${result.prNumber} opened (https://github.com/${deps.targetRepo}/pull/${result.prNumber})`;
            deps.print(`\n${message}`);
            return deps.notifier.postWarning({ message });
          }
          // A merge conflict already posted its own checkpoint via
          // pauseForMergeConflict inside prepareForPr — nothing further to
          // announce here beyond local terminal visibility.
          deps.print(`\n[component ${component.id}] paused on a merge conflict against main`);
        })
        .catch((err) => console.error(`[run-loop] failed to prepare PR for component ${component.id}:`, err));
    }

    const pollGithubClient = new RealGitHubClient({ baseRepoPath: deps.baseRepoPath });
    await pollForMerges(runId, {
      githubClient: pollGithubClient,
      targetRepo: deps.targetRepo,
      baseRepoPath: deps.baseRepoPath,
      schedulerDeps,
    });

    const refreshed = await db.select().from(components).where(eq(components.runId, runId));

    await deps.statusBoard.update(
      runId,
      refreshed.map((c) => ({
        id: c.id,
        taskDescription: c.taskDescription,
        status: c.status,
        branchName: c.branchName,
        prNumber: c.prNumber,
        dependsOn: c.dependsOn,
        startedAt: c.startedAt,
        updatedAt: c.updatedAt,
      })),
    );

    if (refreshed.length > 0 && refreshed.every((c) => c.status === "merged")) {
      deps.print("\nAll components merged. Run complete.");
      await deps.notifier.postWarning({ message: `Run ${runId}: all components merged. Run complete.` });
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, deps.pollIntervalMs ?? 5000));
  }
}
