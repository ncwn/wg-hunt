ALTER TABLE `search_sweeps` ADD `mode` text;--> statement-breakpoint
ALTER TABLE `search_sweeps` ADD `pagesRead` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `search_sweeps` SET `mode` = CASE WHEN `status` = 'idle' THEN NULL WHEN `finishedAt` IS NULL THEN 'backfill' ELSE 'daily' END;
