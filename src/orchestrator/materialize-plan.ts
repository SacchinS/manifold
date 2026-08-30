import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { runs, components } from "../db/schema.js";
import type { Plan } from "./plan-schema.js";

export interface MaterializePlanInput {
  featureDescription: string;
  targetRepo: string;
  repoCreated: boolean;
  plan: Plan;
  worktreesRoot: string;
}

export interface MaterializePlanResult {
  runId: number;
  componentIdByKey: Map<string, number>;
}

// The only DB write module 1 does — a single `runs` row, written only once
// the human has approved (see chat-loop.ts) — plus the `components` rows it
// implies. Two passes: components are inserted first with an empty
// dependsOn to get their real numeric ids, then dependsOn is rewritten from
// the plan's string keys to those ids once the full key->id map exists.
export async function materializeApprovedPlan(input: MaterializePlanInput): Promise<MaterializePlanResult> {
  const [run] = await db
    .insert(runs)
    .values({
      featureDescription: input.featureDescription,
      targetRepo: input.targetRepo,
      repoCreated: input.repoCreated,
      plan: input.plan,
      status: "running",
    })
    .returning();

  const componentIdByKey = new Map<string, number>();

  for (const c of input.plan.components) {
    const [row] = await db
      .insert(components)
      .values({
        runId: run.id,
        branchName: `manifold/${run.id}-${c.id}`,
        worktreePath: path.join(input.worktreesRoot, `${run.id}-${c.id}`),
        taskDescription: c.taskDescription,
        ownedPaths: c.ownedPaths,
        dependsOn: [],
        status: "blocked_on_deps",
      })
      .returning();
    componentIdByKey.set(c.id, row.id);
  }

  for (const c of input.plan.components) {
    const numericDeps = c.dependsOn.map((key) => {
      const id = componentIdByKey.get(key);
      if (id === undefined) throw new Error(`component "${c.id}" depends on unknown component "${key}"`);
      return id;
    });
    await db
      .update(components)
      .set({ dependsOn: numericDeps })
      .where(eq(components.id, componentIdByKey.get(c.id)!));
  }

  return { runId: run.id, componentIdByKey };
}
