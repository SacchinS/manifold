CREATE TABLE `checkpoints` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`component_id` integer NOT NULL,
	`question` text NOT NULL,
	`options` text,
	`screenshot_path` text,
	`slack_thread_ts` text,
	`slack_channel` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`answer` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`component_id`) REFERENCES `components`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `components` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`branch_name` text NOT NULL,
	`worktree_path` text NOT NULL,
	`task_description` text NOT NULL,
	`owned_paths` text NOT NULL,
	`depends_on` text NOT NULL,
	`session_id` text,
	`status` text DEFAULT 'blocked_on_deps' NOT NULL,
	`pr_number` integer,
	`dev_server_port` integer,
	`dev_server_pid` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `decision_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`component_id` integer NOT NULL,
	`entry_type` text NOT NULL,
	`content` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`component_id`) REFERENCES `components`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`feature_description` text NOT NULL,
	`target_repo` text NOT NULL,
	`repo_created` integer NOT NULL,
	`plan` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
