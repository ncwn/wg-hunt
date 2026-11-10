CREATE TABLE `searches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`city` text NOT NULL,
	`categories` text NOT NULL,
	`rentTypes` text NOT NULL,
	`priceCeiling` integer,
	`recencyDays` integer NOT NULL,
	`enabled` integer NOT NULL,
	`pollMinMinutes` integer NOT NULL,
	`pollMaxMinutes` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
