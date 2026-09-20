CREATE TABLE `pf_external_participant` (
	`id` text(41) PRIMARY KEY NOT NULL,
	`email` text(320) NOT NULL,
	`created_at` real DEFAULT (julianday('now')) NOT NULL,
	`updated_at` real DEFAULT (julianday('now')) NOT NULL,
	`created_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`updated_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`_deleted` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pf_external_participant_emailidx_idx` ON `pf_external_participant` (`email`) WHERE _deleted = 0;
--> statement-breakpoint
CREATE INDEX `pf_external_participant_updated_at_id_idx` ON `pf_external_participant` (`updated_at`,`id`);
--> statement-breakpoint
ALTER TABLE `pf_process_state` ADD `started_by_external_participant` text(41);
--> statement-breakpoint
ALTER TABLE `pf_to_do` ADD `completed_by_external_participant` text(41);
--> statement-breakpoint
-- Forward migrations do not rerun the generated trigger bundle, so this table's
-- updated_at trigger is included here for existing SQLite databases.
CREATE TRIGGER IF NOT EXISTS pf_external_participant_updated_at_trigger
AFTER UPDATE ON "pf_external_participant"
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE "pf_external_participant" SET updated_at = julianday('now') WHERE id = NEW.id;
END;
