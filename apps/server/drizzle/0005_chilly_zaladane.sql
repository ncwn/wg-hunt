CREATE TABLE `search_matches` (
	`searchId` integer NOT NULL,
	`source` text NOT NULL,
	`adId` text NOT NULL,
	`lastSeenAt` integer NOT NULL,
	`missingAt` integer,
	PRIMARY KEY(`searchId`, `source`, `adId`),
	FOREIGN KEY (`searchId`) REFERENCES `searches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `search_matches_ad` ON `search_matches` (`source`,`adId`);--> statement-breakpoint
CREATE TABLE `search_sweeps` (
	`searchId` integer PRIMARY KEY NOT NULL,
	`specKey` text NOT NULL,
	`generation` integer NOT NULL,
	`status` text NOT NULL,
	`startAt` integer,
	`startedAt` integer,
	`cursors` text,
	`cardCount` integer DEFAULT 0 NOT NULL,
	`finishedAt` integer,
	FOREIGN KEY (`searchId`) REFERENCES `searches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Ad IDs seen before this table existed count as matched by the Search that first saw them.
INSERT INTO `search_matches` (`searchId`, `source`, `adId`, `lastSeenAt`)
SELECT `seen_ads`.`searchId`, `seen_ads`.`source`, `seen_ads`.`adId`, `seen_ads`.`lastSeenAt`
FROM `seen_ads` INNER JOIN `searches` ON `searches`.`id` = `seen_ads`.`searchId`;
