CREATE TABLE `pf_queue_job_lifecycle` (
	`id` text(41) PRIMARY KEY,
	`queue` text(512) NOT NULL,
	`job_id` text(1024) NOT NULL,
	`job_lifecycle` text NOT NULL,
	`terminal_at` real,
	`created_at` real DEFAULT (julianday('now')) NOT NULL,
	`updated_at` real DEFAULT (julianday('now')) NOT NULL,
	`created_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`updated_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`_deleted` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE `pf_process_execution` ADD `restart_attempt_id` text(36);--> statement-breakpoint
CREATE INDEX `pf_queue_job_lifecycle_terminal_idx_idx` ON `pf_queue_job_lifecycle` (`terminal_at`) WHERE _deleted = 0;--> statement-breakpoint
CREATE UNIQUE INDEX `pf_queue_job_lifecycle_job_id_ix_idx` ON `pf_queue_job_lifecycle` (`queue`,`job_id`) WHERE _deleted = 0;--> statement-breakpoint
CREATE INDEX `pf_queue_job_lifecycle_updated_at_id_idx` ON `pf_queue_job_lifecycle` (`updated_at`,`id`);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS pf_queue_job_lifecycle_updated_at_trigger
AFTER UPDATE ON "pf_queue_job_lifecycle"
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE "pf_queue_job_lifecycle" SET updated_at = julianday('now') WHERE id = NEW.id;
END;
