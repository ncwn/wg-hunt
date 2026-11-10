CREATE TABLE `analysis_batches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`providerBatchId` text,
	`state` text NOT NULL,
	`reservedMicros` integer NOT NULL,
	`requestCount` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`endedAt` integer,
	`requests` text DEFAULT '[]' NOT NULL,
	`checkFailures` integer DEFAULT 0 NOT NULL,
	`canceledAt` integer
);
--> statement-breakpoint
CREATE TABLE `analysis_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`offerId` integer NOT NULL,
	`runId` integer,
	`batchId` integer,
	`stage` integer NOT NULL,
	`state` text NOT NULL,
	`contentHash` text NOT NULL,
	`plan` text NOT NULL,
	`carry` text,
	`errorKind` text,
	`createdAt` integer NOT NULL,
	`finishedAt` integer,
	FOREIGN KEY (`offerId`) REFERENCES `offers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`runId`) REFERENCES `analysis_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`batchId`) REFERENCES `analysis_batches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `analysis_items_state` ON `analysis_items` (`state`);--> statement-breakpoint
CREATE INDEX `analysis_items_offer` ON `analysis_items` (`offerId`);--> statement-breakpoint
CREATE TABLE `analysis_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`createdAt` integer NOT NULL,
	`analysisVersion` text NOT NULL,
	`estimatedCostMicros` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `analysis_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`month` text NOT NULL,
	`model` text NOT NULL,
	`effort` text,
	`batch` integer NOT NULL,
	`inputTokens` integer NOT NULL,
	`outputTokens` integer NOT NULL,
	`thinkingTokens` integer NOT NULL,
	`cacheReadTokens` integer NOT NULL,
	`cacheWriteTokens` integer NOT NULL,
	`costMicros` integer NOT NULL,
	`runId` integer
);
--> statement-breakpoint
CREATE INDEX `analysis_usage_month` ON `analysis_usage` (`month`);