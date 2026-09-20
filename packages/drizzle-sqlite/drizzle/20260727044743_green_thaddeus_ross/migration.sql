PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_pf_passkey_credential` (
	`id` text(41) PRIMARY KEY,
	`user_id` text(41) NOT NULL,
	`passkey_credential_id` text(2048) NOT NULL,
	`passkey_public_key` text(2048) NOT NULL,
	`signature_counter` text(16) NOT NULL,
	`passkey_transports` text,
	`created_at` real DEFAULT (julianday('now')) NOT NULL,
	`updated_at` real DEFAULT (julianday('now')) NOT NULL,
	`created_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`updated_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`_deleted` integer DEFAULT false NOT NULL,
	CONSTRAINT `fk_pf_passkey_credential_user_id_pf_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `pf_user`(`id`)
);
--> statement-breakpoint
INSERT INTO `__new_pf_passkey_credential`(`id`, `user_id`, `passkey_credential_id`, `passkey_public_key`, `signature_counter`, `passkey_transports`, `created_at`, `updated_at`, `created_by`, `updated_by`, `_deleted`) SELECT `id`, `user_id`, `passkey_credential_id`, `passkey_public_key`, `signature_counter`, `passkey_transports`, `created_at`, `updated_at`, `created_by`, `updated_by`, `_deleted` FROM `pf_passkey_credential`;--> statement-breakpoint
DROP TABLE `pf_passkey_credential`;--> statement-breakpoint
ALTER TABLE `__new_pf_passkey_credential` RENAME TO `pf_passkey_credential`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `pf_passkey_credential_credentialidx_idx` ON `pf_passkey_credential` (`passkey_credential_id`) WHERE _deleted = 0;--> statement-breakpoint
CREATE INDEX `pf_passkey_credential_updated_at_id_idx` ON `pf_passkey_credential` (`updated_at`,`id`);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS pf_passkey_credential_updated_at_trigger
AFTER UPDATE ON `pf_passkey_credential`
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
	UPDATE `pf_passkey_credential` SET updated_at = julianday('now') WHERE id = NEW.id;
END;
