CREATE TABLE `offer_texts` (
	`source` text NOT NULL,
	`adId` text NOT NULL,
	`contentHash` text NOT NULL,
	`seenAt` integer NOT NULL,
	`title` text NOT NULL,
	`sections` text NOT NULL,
	PRIMARY KEY(`source`, `adId`, `contentHash`),
	FOREIGN KEY (`source`,`adId`) REFERENCES `offer_ads`(`source`,`adId`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `offer_texts_ad` ON `offer_texts` (`source`,`adId`,`seenAt`);