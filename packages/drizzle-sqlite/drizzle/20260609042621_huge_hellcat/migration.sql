ALTER TABLE `pf_to_do` ADD `correction_required_at` real;--> statement-breakpoint
ALTER TABLE `pf_to_do` ADD `correction_failure_reason` text collate nocase;--> statement-breakpoint
ALTER TABLE `pf_to_do` ADD `correction_invitation_attempt_id` text(41);
