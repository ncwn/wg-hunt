CREATE TABLE `seen_ads` (
	`source` text NOT NULL,
	`adId` text NOT NULL,
	`firstSeenAt` integer NOT NULL,
	`lastSeenAt` integer NOT NULL,
	`searchId` integer NOT NULL,
	`category` text NOT NULL,
	`onlineEarliest` integer,
	`onlineLatest` integer,
	`card` text NOT NULL,
	`detailState` text NOT NULL,
	`detailAttempts` integer DEFAULT 0 NOT NULL,
	`detailFetchedAt` integer,
	`snapshotFile` text,
	PRIMARY KEY(`source`, `adId`)
);
--> statement-breakpoint
ALTER TABLE `searches` ADD `cityId` text;