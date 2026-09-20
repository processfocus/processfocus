CREATE TABLE `pf_registration_session` (
	`id` text(41) PRIMARY KEY,
	`registration_session_token_hash` text(64) NOT NULL,
	`invitation_id` text(41) NOT NULL,
	`registration_link_generation` integer NOT NULL,
	`registration_session_expires_at` real NOT NULL,
	`created_at` real DEFAULT (julianday('now')) NOT NULL,
	`updated_at` real DEFAULT (julianday('now')) NOT NULL,
	`created_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`updated_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`_deleted` integer DEFAULT false NOT NULL,
	CONSTRAINT `fk_pf_registration_session_invitation_id_pf_invitation_id_fk` FOREIGN KEY (`invitation_id`) REFERENCES `pf_invitation`(`id`)
);
--> statement-breakpoint
CREATE INDEX `pf_registration_session_invitationidx_idx` ON `pf_registration_session` (`invitation_id`) WHERE _deleted = 0;--> statement-breakpoint
CREATE UNIQUE INDEX `pf_registration_session_tokenhashidx_idx` ON `pf_registration_session` (`registration_session_token_hash`) WHERE _deleted = 0;--> statement-breakpoint
CREATE INDEX `pf_registration_session_updated_at_id_idx` ON `pf_registration_session` (`updated_at`,`id`);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS pf_registration_session_updated_at_trigger
AFTER UPDATE ON "pf_registration_session"
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE "pf_registration_session" SET updated_at = julianday('now') WHERE id = NEW.id;
END;
