-- Sessions now expire and name the token they were issued under. Rows from before carry
-- neither, so they are dropped: an open dashboard signs in once more.
DROP TABLE `dashboard_sessions`;--> statement-breakpoint
CREATE TABLE `dashboard_sessions` (
	`idHash` text PRIMARY KEY NOT NULL,
	`tokenTag` text NOT NULL,
	`createdAt` integer NOT NULL,
	`lastUsedAt` integer NOT NULL
);
