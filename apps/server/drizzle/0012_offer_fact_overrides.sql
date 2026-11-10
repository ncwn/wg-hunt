CREATE TABLE `offer_fact_overrides` (
	`offerId` integer NOT NULL,
	`fact` text NOT NULL,
	`value` text NOT NULL,
	`createdAt` integer NOT NULL,
	PRIMARY KEY(`offerId`, `fact`),
	FOREIGN KEY (`offerId`) REFERENCES `offers`(`id`) ON UPDATE no action ON DELETE cascade
);
