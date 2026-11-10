CREATE TABLE `offer_tombstones` (
	`offerId` integer PRIMARY KEY NOT NULL,
	`mergedInto` integer NOT NULL,
	`mergedAt` integer NOT NULL,
	FOREIGN KEY (`mergedInto`) REFERENCES `offers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `offer_tombstones_into` ON `offer_tombstones` (`mergedInto`);