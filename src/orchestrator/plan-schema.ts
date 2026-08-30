import { z } from "zod";

// Referenced by string key within the plan, not a real database id — no
// components row exists yet at this stage (module 1: nothing is persisted
// until the human approves). materialize-plan.ts maps these keys to real
// numeric component ids once the plan is finalized.
export const planComponentSchema = z.object({
  id: z.string().describe("A short, unique key for this component within the plan, e.g. 'ui' or 'api'"),
  taskDescription: z.string(),
  ownedPaths: z.array(z.string()),
  dependsOn: z.array(z.string()).describe("ids of other components in this same plan that must merge before this one starts"),
});

export const planSchema = z.object({
  components: z.array(planComponentSchema),
});

export type PlanComponent = z.infer<typeof planComponentSchema>;
export type Plan = z.infer<typeof planSchema>;
