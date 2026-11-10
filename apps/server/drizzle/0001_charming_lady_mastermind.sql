CREATE TABLE `crawl_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`priority` integer NOT NULL,
	`path` text NOT NULL,
	`payload` text,
	`dueAt` integer NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `crawl_jobs_kind_path` ON `crawl_jobs` (`kind`,`path`);--> statement-breakpoint
CREATE INDEX `crawl_jobs_order` ON `crawl_jobs` (`priority`,`dueAt`,`id`);--> statement-breakpoint
CREATE TABLE `crawl_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`kind` text NOT NULL,
	`path` text NOT NULL,
	`status` integer,
	`outcome` text NOT NULL,
	`marker` text
);
--> statement-breakpoint
CREATE INDEX `crawl_requests_at` ON `crawl_requests` (`at`);