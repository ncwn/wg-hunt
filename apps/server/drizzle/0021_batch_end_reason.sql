ALTER TABLE `analysis_batches` ADD `endReason` text;--> statement-breakpoint
UPDATE `analysis_batches` SET `state` = 'canceling' WHERE `state` = 'in_progress' AND `canceledAt` IS NOT NULL;
