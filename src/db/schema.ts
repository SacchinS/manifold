import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// See manifold-handoff.md for the design this schema implements.
//
// A `runs` row is written only once the human has approved a plan in the
// orchestrator's synchronous chat loop (module 1) — there is no persisted
// "planning" or "awaiting approval" state.
export const runs = sqliteTable("runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  featureDescription: text("feature_description").notNull(),
  targetRepo: text("target_repo").notNull(),
  repoCreated: integer("repo_created", { mode: "boolean" }).notNull(),
  plan: text("plan", { mode: "json" }).notNull(),
  status: text("status", { enum: ["running", "done", "abandoned"] })
    .notNull()
    .default("running"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const components = sqliteTable("components", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: integer("run_id")
    .notNull()
    .references(() => runs.id),
  branchName: text("branch_name").notNull(),
  worktreePath: text("worktree_path").notNull(),
  taskDescription: text("task_description").notNull(),
  ownedPaths: text("owned_paths", { mode: "json" }).$type<string[]>().notNull(),
  dependsOn: text("depends_on", { mode: "json" }).$type<number[]>().notNull(),
  sessionId: text("session_id"),
  status: text("status", {
    enum: [
      "blocked_on_deps",
      "in_progress",
      "awaiting_input",
      "ready_for_pr",
      "pr_open",
      "merged",
      "conflict_paused",
      "usage_paused",
    ],
  })
    .notNull()
    .default("blocked_on_deps"),
  prNumber: integer("pr_number"),
  // Allocated lazily on the first visual ask_human checkpoint (module 4).
  devServerPort: integer("dev_server_port"),
  devServerPid: integer("dev_server_pid"),
  // Set once, the moment the scheduler actually launches this component
  // (blocked_on_deps -> in_progress) — distinct from createdAt, which is
  // set at plan materialization and may be long before launch if this
  // component had to wait on dependencies. Used for the status board's
  // "how long it's been running" display.
  startedAt: integer("started_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

// Component-scoped only — plan negotiation (module 1) does not use this table.
export const checkpoints = sqliteTable("checkpoints", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  componentId: integer("component_id")
    .notNull()
    .references(() => components.id),
  question: text("question").notNull(),
  options: text("options", { mode: "json" }).$type<string[]>(),
  screenshotPath: text("screenshot_path"),
  slackThreadTs: text("slack_thread_ts"),
  slackChannel: text("slack_channel"),
  status: text("status", { enum: ["pending", "resolved"] })
    .notNull()
    .default("pending"),
  answer: text("answer"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  resolvedAt: integer("resolved_at", { mode: "timestamp" }),
});

// Append-only. Not replayed into a resumed agent's context — the Claude
// Agent SDK's own session resume already carries the transcript. This is
// purely the structured trail that PR generation (module 8) summarizes.
export const decisionLog = sqliteTable("decision_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  componentId: integer("component_id")
    .notNull()
    .references(() => components.id),
  entryType: text("entry_type", {
    enum: ["checkpoint_resolved", "autonomous_decision", "conflict_event", "runaway_event"],
  }).notNull(),
  content: text("content").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});
