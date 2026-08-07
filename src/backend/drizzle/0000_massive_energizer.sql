CREATE TABLE `actions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`type` text NOT NULL,
	`params` text NOT NULL,
	`status` text NOT NULL,
	`decision` text,
	`decision_reason` text,
	`idempotency_key` text NOT NULL,
	`result` text,
	`error` text,
	`created_at` text NOT NULL,
	`decided_at` text,
	`executed_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `actions_project_idempotency_unique` ON `actions` (`project_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `actions_project_status_created_idx` ON `actions` (`project_id`,`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`action_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`decision` text,
	`decided_at` text,
	`decided_by` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`action_id`) REFERENCES `actions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `approvals_token_hash_unique` ON `approvals` (`token_hash`);--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`action_id` text,
	`project_id` text NOT NULL,
	`event` text NOT NULL,
	`data` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`action_id`) REFERENCES `actions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `audit_events_action_created_idx` ON `audit_events` (`action_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `policies` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`action_type` text NOT NULL,
	`max_amount_cents` integer,
	`hard_max_amount_cents` integer,
	`daily_cap_cents` integer,
	`allowed_recipients` text,
	`requires_approval` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `policies_project_action_unique` ON `policies` (`project_id`,`action_type`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`api_key_hash` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_api_key_hash_unique` ON `projects` (`api_key_hash`);