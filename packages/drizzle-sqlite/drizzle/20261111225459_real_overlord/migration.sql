CREATE TABLE `pf_audit_event` (
	`id` text(41) PRIMARY KEY,
	`audit_kind` text(16) NOT NULL,
	`occurred_at` real NOT NULL,
	`audit_details` text NOT NULL,
	`created_at` real DEFAULT (julianday('now')) NOT NULL,
	`updated_at` real DEFAULT (julianday('now')) NOT NULL,
	`created_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`updated_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`_deleted` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pf_audit_event_updated_at_id_idx` ON `pf_audit_event` (`updated_at`,`id`);