CREATE TABLE `pf_external_credential_handoff` (
	`id` text(41) PRIMARY KEY,
	`credential_reference` text(64) NOT NULL,
	`organisation_scope` text(256) NOT NULL,
	`email` text(320) NOT NULL,
	`process_execution_id` text(41) NOT NULL,
	`to_do_id` text(41) NOT NULL,
	`provider` text(128) NOT NULL,
	`resource_id` text(2048) NOT NULL,
	`encryption_nonce` text(16) NOT NULL,
	`authentication_tag` text(32) NOT NULL,
	`encrypted_credential` text collate nocase NOT NULL,
	`encryption_version` integer NOT NULL,
	`expires_at` real NOT NULL,
	`created_at` real DEFAULT (julianday('now')) NOT NULL,
	`updated_at` real DEFAULT (julianday('now')) NOT NULL,
	`created_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`updated_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`_deleted` integer DEFAULT false NOT NULL,
	CONSTRAINT `fk_pf_external_credential_handoff_process_execution_id_pf_process_execution_id_fk` FOREIGN KEY (`process_execution_id`) REFERENCES `pf_process_execution`(`id`),
	CONSTRAINT `fk_pf_external_credential_handoff_to_do_id_pf_to_do_id_fk` FOREIGN KEY (`to_do_id`) REFERENCES `pf_to_do`(`id`)
);
--> statement-breakpoint
CREATE INDEX `pf_external_credential_handoff_expiryidx_idx` ON `pf_external_credential_handoff` (`expires_at`) WHERE _deleted = 0;--> statement-breakpoint
CREATE UNIQUE INDEX `pf_external_credential_handoff_referenceidx_idx` ON `pf_external_credential_handoff` (`credential_reference`) WHERE _deleted = 0;--> statement-breakpoint
CREATE INDEX `pf_external_credential_handoff_updated_at_id_idx` ON `pf_external_credential_handoff` (`updated_at`,`id`);