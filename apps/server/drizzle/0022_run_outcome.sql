ALTER TABLE `analysis_runs` ADD `status` text DEFAULT 'running' NOT NULL;--> statement-breakpoint
ALTER TABLE `analysis_runs` ADD `finishedAt` integer;--> statement-breakpoint
ALTER TABLE `analysis_runs` ADD `stopReason` text;--> statement-breakpoint
ALTER TABLE `analysis_runs` ADD `offerCount` integer;--> statement-breakpoint
ALTER TABLE `analysis_runs` ADD `appliedCount` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `analysis_runs` ADD `failedCount` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `analysis_runs` ADD `cappedCount` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `analysis_runs` ADD `droppedCount` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `analysis_runs` ADD `errorKinds` text DEFAULT '{}' NOT NULL;