CREATE TABLE `pf_process_visibility` (
	`id` text(41) PRIMARY KEY,
	`process_id` text(41) NOT NULL,
	`replication_scope` text(64) NOT NULL,
	`created_at` real DEFAULT (julianday('now')) NOT NULL,
	`updated_at` real DEFAULT (julianday('now')) NOT NULL,
	`created_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`updated_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`_deleted` integer DEFAULT false NOT NULL,
	CONSTRAINT `fk_pf_process_visibility_process_id_pf_process_id_fk` FOREIGN KEY (`process_id`) REFERENCES `pf_process`(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pf_process_visibility_scopeprocessidx_idx` ON `pf_process_visibility` (`replication_scope`,`process_id`) WHERE _deleted = 0;--> statement-breakpoint
CREATE INDEX `pf_process_visibility_updated_at_id_idx` ON `pf_process_visibility` (`updated_at`,`id`);