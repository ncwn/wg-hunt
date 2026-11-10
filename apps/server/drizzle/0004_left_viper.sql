CREATE TABLE `offer_ads` (
	`source` text NOT NULL,
	`adId` text NOT NULL,
	`offerId` integer NOT NULL,
	`path` text NOT NULL,
	`firstSeenAt` integer NOT NULL,
	`lastBumpAt` integer,
	`pageStatus` text NOT NULL,
	`contentHash` text,
	PRIMARY KEY(`source`, `adId`),
	FOREIGN KEY (`offerId`) REFERENCES `offers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `offer_ads_offer` ON `offer_ads` (`offerId`);--> statement-breakpoint
CREATE TABLE `offer_prices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`offerId` integer NOT NULL,
	`source` text NOT NULL,
	`adId` text NOT NULL,
	`observedAt` integer NOT NULL,
	`amount` real NOT NULL,
	`converted` integer NOT NULL,
	FOREIGN KEY (`offerId`) REFERENCES `offers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `offer_prices_offer` ON `offer_prices` (`offerId`,`observedAt`,`id`);--> statement-breakpoint
CREATE TABLE `offers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`category` text NOT NULL,
	`title` text NOT NULL,
	`facts` text NOT NULL,
	`card` text NOT NULL,
	`rulesVersion` integer NOT NULL,
	`analysisState` text NOT NULL,
	`firstSeenAt` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `offers_created` ON `offers` (`createdAt`,`id`);--> statement-breakpoint
ALTER TABLE `seen_ads` ADD `ingestedAt` integer;