CREATE TABLE `pf_public_completion_invitation_attempt` (
	`id` text(41) PRIMARY KEY NOT NULL,
	`to_do_id` text(41) NOT NULL,
	`email` text(320) NOT NULL,
	`provider_message_id` text(256),
	`provider_sent_to` text collate nocase,
	`created_at` real DEFAULT (julianday('now')) NOT NULL,
	`updated_at` real DEFAULT (julianday('now')) NOT NULL,
	`created_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`updated_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`_deleted` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`to_do_id`) REFERENCES `pf_to_do`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `pf_public_completion_invitation_attempt_todoidx_idx` ON `pf_public_completion_invitation_attempt` (`to_do_id`) WHERE _deleted = 0;--> statement-breakpoint
CREATE INDEX `pf_public_completion_invitation_attempt_updated_at_id_idx` ON `pf_public_completion_invitation_attempt` (`updated_at`,`id`);
--> statement-breakpoint
-- Forward migrations do not rerun the generated trigger bundle, so this table's
-- updated_at trigger is included here for existing SQLite databases.
CREATE TRIGGER IF NOT EXISTS pf_public_completion_invitation_attempt_updated_at_trigger
AFTER UPDATE ON "pf_public_completion_invitation_attempt"
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE "pf_public_completion_invitation_attempt" SET updated_at = julianday('now') WHERE id = NEW.id;
END;
