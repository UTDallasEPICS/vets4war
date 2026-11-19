CREATE TABLE `calls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`start_ts` text NOT NULL,
	`in_queue_sec` real,
	`agent_sec` real,
	`abandon_sec` real,
	`routing_sec` real,
	`abandoned` integer NOT NULL,
	`upload_id` integer NOT NULL,
	FOREIGN KEY (`upload_id`) REFERENCES `uploads`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `calls_start_ts_idx` ON `calls` (`start_ts`);--> statement-breakpoint
CREATE TABLE `data_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`calls_revision` integer DEFAULT 0 NOT NULL,
	`rerun_requested` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `forecast_cells` (
	`recency` text NOT NULL,
	`dow` integer NOT NULL,
	`hour` integer NOT NULL,
	`aht_sec` real NOT NULL,
	`real_share` real NOT NULL,
	PRIMARY KEY(`recency`, `dow`, `hour`)
);
--> statement-breakpoint
CREATE TABLE `forecast_hours` (
	`date` text NOT NULL,
	`hour` integer NOT NULL,
	`predicted_calls` real NOT NULL,
	`predicted_calls_no_holidays` real NOT NULL,
	PRIMARY KEY(`date`, `hour`)
);
--> statement-breakpoint
CREATE TABLE `forecast_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trigger` text NOT NULL,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`requested_by_label` text,
	`upload_id` integer,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`pid` integer,
	`exit_code` integer,
	`calls_revision` integer,
	`calls_count` integer,
	`data_start` text,
	`data_end` text,
	`trained` integer,
	`model_id` integer,
	`gate_passed` integer,
	`gate_json` text,
	`forecast_written` integer,
	`horizon_start` text,
	`horizon_end` text,
	`message` text,
	`log_tail` text
);
--> statement-breakpoint
CREATE INDEX `forecast_runs_status_idx` ON `forecast_runs` (`status`);--> statement-breakpoint
CREATE INDEX `forecast_runs_created_idx` ON `forecast_runs` (`created_at`);--> statement-breakpoint
CREATE TABLE `forecast_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`run_id` integer NOT NULL,
	`model_id` integer NOT NULL,
	`generated_at` integer NOT NULL,
	`calls_revision` integer NOT NULL,
	`calls_count` integer NOT NULL,
	`data_start` text NOT NULL,
	`data_end` text NOT NULL,
	`horizon_start` text NOT NULL,
	`horizon_end` text NOT NULL,
	`patience_sec` real NOT NULL,
	`patience_n_abandoned` integer NOT NULL,
	`patience_n_calls` integer NOT NULL,
	`quick_hangups_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `holidays` (
	`holiday_date` text PRIMARY KEY NOT NULL,
	`holiday_name` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `model_artifacts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`model_sha256` text NOT NULL,
	`model_text` text NOT NULL,
	`metadata_json` text NOT NULL,
	`train_start` text NOT NULL,
	`train_end` text NOT NULL,
	`train_rows` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `replaced_calls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`replaced_by_upload_id` integer NOT NULL,
	`original_upload_id` integer,
	`start_ts` text NOT NULL,
	`in_queue_sec` real,
	`agent_sec` real,
	`abandon_sec` real,
	`routing_sec` real,
	`abandoned` integer NOT NULL,
	FOREIGN KEY (`replaced_by_upload_id`) REFERENCES `uploads`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `replaced_calls_upload_idx` ON `replaced_calls` (`replaced_by_upload_id`);--> statement-breakpoint
CREATE TABLE `upload_rows` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`upload_id` integer NOT NULL,
	`start_ts` text NOT NULL,
	`in_queue_sec` real NOT NULL,
	`agent_sec` real NOT NULL,
	`abandon_sec` real NOT NULL,
	`routing_sec` real NOT NULL,
	`abandoned` integer NOT NULL,
	FOREIGN KEY (`upload_id`) REFERENCES `uploads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `upload_rows_upload_idx` ON `upload_rows` (`upload_id`,`start_ts`);--> statement-breakpoint
CREATE TABLE `uploads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`status` text NOT NULL,
	`filename` text NOT NULL,
	`file_sha256` text NOT NULL,
	`file_bytes` integer NOT NULL,
	`uploaded_by` text,
	`uploaded_by_label` text NOT NULL,
	`created_at` integer NOT NULL,
	`parsed_at` integer,
	`imported_at` integer,
	`imported_by_label` text,
	`total_rows` integer,
	`first_day` text,
	`last_day` text,
	`report_json` text,
	`result_json` text,
	`error` text,
	`run_id` integer,
	FOREIGN KEY (`uploaded_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `uploads_created_idx` ON `uploads` (`created_at`);--> statement-breakpoint
CREATE INDEX `uploads_sha_idx` ON `uploads` (`file_sha256`);--> statement-breakpoint
ALTER TABLE `user` ADD `role` text DEFAULT 'viewer' NOT NULL;