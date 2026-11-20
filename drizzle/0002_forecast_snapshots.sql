CREATE TABLE `forecast_snapshots` (
	`date` text NOT NULL,
	`hour` integer NOT NULL,
	`predicted_calls` real NOT NULL,
	`model_id` integer NOT NULL,
	`run_id` integer NOT NULL,
	`upload_id` integer NOT NULL,
	`captured_at` integer NOT NULL,
	PRIMARY KEY(`date`, `hour`)
);
