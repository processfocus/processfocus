CREATE TABLE `pf_not_started_job` (
	`id` text(41) PRIMARY KEY,
	`queue` text(512) NOT NULL,
	`job_id` text(1024) NOT NULL,
	`not_started_reason` text collate nocase NOT NULL,
	`created_at` real DEFAULT (julianday('now')) NOT NULL,
	`updated_at` real DEFAULT (julianday('now')) NOT NULL,
	`created_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`updated_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`_deleted` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE `pf_process_execution` ADD `not_started_reason` text collate nocase;--> statement-breakpoint
ALTER TABLE `pf_to_do` ADD `not_started_reason` text collate nocase;--> statement-breakpoint
CREATE UNIQUE INDEX `pf_not_started_job_job_id_ix_idx` ON `pf_not_started_job` (`queue`,`job_id`) WHERE _deleted = 0;--> statement-breakpoint
CREATE INDEX `pf_not_started_job_updated_at_id_idx` ON `pf_not_started_job` (`updated_at`,`id`);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS pf_not_started_job_updated_at_trigger
AFTER UPDATE ON "pf_not_started_job"
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE "pf_not_started_job" SET updated_at = julianday('now') WHERE id = NEW.id;
END;
