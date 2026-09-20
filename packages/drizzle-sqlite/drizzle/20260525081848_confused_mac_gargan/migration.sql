CREATE TABLE `pf_step_supporting_role` (
	`id` text(41) PRIMARY KEY NOT NULL,
	`step_id` text(41) NOT NULL,
	`role_id` text(41) NOT NULL,
	`created_at` real DEFAULT (julianday('now')) NOT NULL,
	`updated_at` real DEFAULT (julianday('now')) NOT NULL,
	`created_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`updated_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`_deleted` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`step_id`) REFERENCES `pf_step`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`role_id`) REFERENCES `pf_role`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pf_step_supporting_role_steproleidx_idx` ON `pf_step_supporting_role` (`step_id`,`role_id`) WHERE _deleted = 0;--> statement-breakpoint
CREATE INDEX `pf_step_supporting_role_updated_at_id_idx` ON `pf_step_supporting_role` (`updated_at`,`id`);--> statement-breakpoint
ALTER TABLE `pf_to_do` ADD `completed_by_role` text(41) REFERENCES pf_role(id);
