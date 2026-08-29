import { asc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { components, decisionLog } from "../db/schema.js";
import type { GitHubClient, SummaryWriter } from "./types.js";

export interface GeneratePrDeps {
  summaryWriter: SummaryWriter;
  githubClient: GitHubClient;
  targetRepo: string;
  baseBranch: string;
}

export interface GeneratePrResult {
  prNumber: number;
  body: string;
}

// Module 8, steps 1-4 in manifold-handoff.md.
export async function generatePr(componentId: number, deps: GeneratePrDeps): Promise<GeneratePrResult> {
  const [component] = await db.select().from(components).where(eq(components.id, componentId));
  if (!component) throw new Error(`component ${componentId} not found`);
  if (component.status !== "ready_for_pr") {
    throw new Error(`component ${componentId} is not ready_for_pr (status: ${component.status})`);
  }

  const entries = await db
    .select()
    .from(decisionLog)
    .where(eq(decisionLog.componentId, componentId))
    .orderBy(asc(decisionLog.id));

  const body = await deps.summaryWriter.writeSummaryDoc({
    taskDescription: component.taskDescription,
    decisionLogEntries: entries,
  });

  const { prNumber } = await deps.githubClient.createPullRequest({
    targetRepo: deps.targetRepo,
    branchName: component.branchName,
    baseBranch: deps.baseBranch,
    title: component.taskDescription,
    body,
  });

  await db.update(components).set({ status: "pr_open", prNumber, updatedAt: new Date() }).where(eq(components.id, componentId));

  return { prNumber, body };
}
