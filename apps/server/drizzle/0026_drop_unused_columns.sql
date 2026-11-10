DROP INDEX `offers_created`;--> statement-breakpoint
ALTER TABLE `analysis_batches` DROP COLUMN `canceledAt`;--> statement-breakpoint
ALTER TABLE `crawl_jobs` DROP COLUMN `createdAt`;--> statement-breakpoint
ALTER TABLE `offer_links` DROP COLUMN `createdAt`;--> statement-breakpoint
ALTER TABLE `offer_tombstones` DROP COLUMN `mergedAt`;--> statement-breakpoint
ALTER TABLE `seen_ads` DROP COLUMN `searchId`;--> statement-breakpoint
ALTER TABLE `seen_ads` DROP COLUMN `snapshotFile`;