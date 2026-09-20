CREATE TABLE `pf_passkey_credential` (
	`id` text(41) PRIMARY KEY,
	`user_id` text(41) NOT NULL,
	`passkey_credential_id` text(2048) NOT NULL,
	`passkey_public_key` text(2048) NOT NULL,
	`signature_counter` integer NOT NULL,
	`passkey_transports` text,
	`created_at` real DEFAULT (julianday('now')) NOT NULL,
	`updated_at` real DEFAULT (julianday('now')) NOT NULL,
	`created_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`updated_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`_deleted` integer DEFAULT false NOT NULL,
	CONSTRAINT `fk_pf_passkey_credential_user_id_pf_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `pf_user`(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pf_passkey_credential_credentialidx_idx` ON `pf_passkey_credential` (`passkey_credential_id`) WHERE _deleted = 0;--> statement-breakpoint
CREATE INDEX `pf_passkey_credential_updated_at_id_idx` ON `pf_passkey_credential` (`updated_at`,`id`);
--> statement-breakpoint
DELETE FROM `pf_oauth_storage` WHERE `key_kind` = 'passkey';
--> statement-breakpoint
UPDATE `pf_provider_user_role`
SET `_deleted` = 1, `updated_at` = julianday('now'), `updated_by` = 'SYSTEM'
WHERE `_deleted` = 0 AND `provider_user_id` IN (
	SELECT `pu`.`id` FROM `pf_provider_user` `pu`
	INNER JOIN `pf_user` `u` ON `u`.`id` = `pu`.`user_id`
	WHERE `u`.`provider` = 'passkey' AND `u`.`_deleted` = 0
);
--> statement-breakpoint
UPDATE `pf_permitted_role`
SET `_deleted` = 1, `updated_at` = julianday('now'), `updated_by` = 'SYSTEM'
WHERE `_deleted` = 0 AND `provider_user_id` IN (
	SELECT `pu`.`id` FROM `pf_provider_user` `pu`
	INNER JOIN `pf_user` `u` ON `u`.`id` = `pu`.`user_id`
	WHERE `u`.`provider` = 'passkey' AND `u`.`_deleted` = 0
);
--> statement-breakpoint
UPDATE `pf_user_settings`
SET `_deleted` = 1, `updated_at` = julianday('now'), `updated_by` = 'SYSTEM'
WHERE `_deleted` = 0 AND `user_id` IN (
	SELECT `id` FROM `pf_user` WHERE `provider` = 'passkey' AND `_deleted` = 0
);
--> statement-breakpoint
UPDATE `pf_provider_user`
SET `_deleted` = 1, `updated_at` = julianday('now'), `updated_by` = 'SYSTEM'
WHERE `_deleted` = 0 AND `user_id` IN (
	SELECT `id` FROM `pf_user` WHERE `provider` = 'passkey' AND `_deleted` = 0
);
--> statement-breakpoint
UPDATE `pf_user`
SET `_deleted` = 1, `updated_at` = julianday('now'), `updated_by` = 'SYSTEM'
WHERE `_deleted` = 0 AND `provider` = 'passkey';
