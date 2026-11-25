CREATE TABLE `pf_task_deadline` (
	`id` text(41) PRIMARY KEY,
	`owner_to_do` text(41) NOT NULL,
	`flow_id` text(41) NOT NULL,
	`deadline_name` text(100) NOT NULL,
	`scheduled_at` real NOT NULL,
	`triggered_at` real,
	`disarmed_at` real,
	`created_at` real DEFAULT (julianday('now')) NOT NULL,
	`updated_at` real DEFAULT (julianday('now')) NOT NULL,
	`created_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`updated_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`_deleted` integer DEFAULT false NOT NULL,
	CONSTRAINT `fk_pf_task_deadline_owner_to_do_pf_to_do_id_fk` FOREIGN KEY (`owner_to_do`) REFERENCES `pf_to_do`(`id`),
	CONSTRAINT `fk_pf_task_deadline_flow_id_pf_flow_id_fk` FOREIGN KEY (`flow_id`) REFERENCES `pf_flow`(`id`)
);
--> statement-breakpoint
ALTER TABLE `pf_flow` ADD `deadline_name` text(100);--> statement-breakpoint
CREATE UNIQUE INDEX `pf_task_deadline_activationname_idx` ON `pf_task_deadline` (`owner_to_do`,`deadline_name`) WHERE _deleted = 0;--> statement-breakpoint
CREATE INDEX `pf_task_deadline_updated_at_id_idx` ON `pf_task_deadline` (`updated_at`,`id`);