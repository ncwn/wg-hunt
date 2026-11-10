CREATE TABLE `offer_links` (
	`source` text NOT NULL,
	`adId` text NOT NULL,
	`otherAdId` text NOT NULL,
	`kind` text NOT NULL,
	`sharedImages` integer NOT NULL,
	`textSimilarity` real,
	`createdAt` integer NOT NULL,
	PRIMARY KEY(`source`, `adId`, `otherAdId`)
);
--> statement-breakpoint
CREATE INDEX `offer_links_other` ON `offer_links` (`source`,`otherAdId`);--> statement-breakpoint
CREATE TABLE `offer_pair_overrides` (
	`source` text NOT NULL,
	`adIdA` text NOT NULL,
	`adIdB` text NOT NULL,
	`verdict` text NOT NULL,
	`createdAt` integer NOT NULL,
	PRIMARY KEY(`source`, `adIdA`, `adIdB`)
);
--> statement-breakpoint
CREATE INDEX `offer_pair_overrides_b` ON `offer_pair_overrides` (`source`,`adIdB`);--> statement-breakpoint
ALTER TABLE `offer_ads` ADD `profile` text;--> statement-breakpoint
ALTER TABLE `offer_ads` ADD `category` text;--> statement-breakpoint
ALTER TABLE `offer_ads` ADD `postalCode` text;--> statement-breakpoint
CREATE INDEX `offer_ads_bucket` ON `offer_ads` (`source`,`category`,`postalCode`);--> statement-breakpoint
UPDATE `offer_ads` SET `category` = (SELECT `category` FROM `offers` WHERE `offers`.`id` = `offer_ads`.`offerId`);