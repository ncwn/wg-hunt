ALTER TABLE `offers` ADD `dismissed` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `offers` ADD `shortlisted` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `offers` ADD `contacted` integer DEFAULT false NOT NULL;