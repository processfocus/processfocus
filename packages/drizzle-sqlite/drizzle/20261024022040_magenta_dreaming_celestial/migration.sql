ALTER TABLE `pf_job_queue` ADD `terminal_at` real;--> statement-breakpoint
ALTER TABLE `pf_job_queue` ADD `terminal_reason` text collate nocase;--> statement-breakpoint
ALTER TABLE `pf_job_queue` ADD `terminal_outcome` text(32);--> statement-breakpoint
ALTER TABLE `pf_job_queue` ADD `redriven_from` text(64);