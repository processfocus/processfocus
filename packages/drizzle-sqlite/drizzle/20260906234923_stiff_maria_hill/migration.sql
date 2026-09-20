CREATE TABLE `pf_delegation` (
	`id` text(41) PRIMARY KEY,
	`owner_provider_user` text(41) NOT NULL,
	`delegation_name` text(128) NOT NULL,
	`active_delegation_name` text(128),
	`secret_revoked_at` real,
	`created_at` real DEFAULT (julianday('now')) NOT NULL,
	`updated_at` real DEFAULT (julianday('now')) NOT NULL,
	`created_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`updated_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`_deleted` integer DEFAULT false NOT NULL,
	CONSTRAINT `fk_pf_delegation_owner_provider_user_pf_provider_user_id_fk` FOREIGN KEY (`owner_provider_user`) REFERENCES `pf_provider_user`(`id`)
);
--> statement-breakpoint
CREATE TABLE `pf_delegation_history` (
	`id` text(41) PRIMARY KEY,
	`delegation_id` text(41) NOT NULL,
	`secret_generation_id` text(41) NOT NULL,
	`actor_provider_user` text(41) NOT NULL,
	`delegation_event` text(32) NOT NULL,
	`secret_issued_at` real NOT NULL,
	`created_at` real DEFAULT (julianday('now')) NOT NULL,
	`updated_at` real DEFAULT (julianday('now')) NOT NULL,
	`created_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`updated_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`_deleted` integer DEFAULT false NOT NULL,
	CONSTRAINT `fk_pf_delegation_history_delegation_id_pf_delegation_id_fk` FOREIGN KEY (`delegation_id`) REFERENCES `pf_delegation`(`id`),
	CONSTRAINT `fk_pf_delegation_history_secret_generation_id_pf_secret_generation_id_fk` FOREIGN KEY (`secret_generation_id`) REFERENCES `pf_secret_generation`(`id`),
	CONSTRAINT `fk_pf_delegation_history_actor_provider_user_pf_provider_user_id_fk` FOREIGN KEY (`actor_provider_user`) REFERENCES `pf_provider_user`(`id`)
);
--> statement-breakpoint
CREATE TABLE `pf_secret_generation` (
	`id` text(41) PRIMARY KEY,
	`delegation_id` text(41) NOT NULL,
	`secret_verifier` text(64) NOT NULL,
	`secret_issued_at` real NOT NULL,
	`secret_expires_at` real NOT NULL,
	`secret_revoked_at` real,
	`secret_last_used_at` real,
	`created_at` real DEFAULT (julianday('now')) NOT NULL,
	`updated_at` real DEFAULT (julianday('now')) NOT NULL,
	`created_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`updated_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`_deleted` integer DEFAULT false NOT NULL,
	CONSTRAINT `fk_pf_secret_generation_delegation_id_pf_delegation_id_fk` FOREIGN KEY (`delegation_id`) REFERENCES `pf_delegation`(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pf_delegation_ownernameidx_idx` ON `pf_delegation` (`owner_provider_user`,`active_delegation_name`) WHERE _deleted = 0;--> statement-breakpoint
CREATE INDEX `pf_delegation_updated_at_id_idx` ON `pf_delegation` (`updated_at`,`id`);--> statement-breakpoint
CREATE INDEX `pf_delegation_history_updated_at_id_idx` ON `pf_delegation_history` (`updated_at`,`id`);--> statement-breakpoint
CREATE INDEX `pf_secret_generation_delegationidx_idx` ON `pf_secret_generation` (`delegation_id`) WHERE _deleted = 0;--> statement-breakpoint
CREATE UNIQUE INDEX `pf_secret_generation_verifieridx_idx` ON `pf_secret_generation` (`secret_verifier`) WHERE _deleted = 0;--> statement-breakpoint
CREATE INDEX `pf_secret_generation_updated_at_id_idx` ON `pf_secret_generation` (`updated_at`,`id`);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS pf_delegation_updated_at_trigger
AFTER UPDATE ON "pf_delegation"
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE "pf_delegation" SET updated_at = julianday('now') WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS pf_secret_generation_updated_at_trigger
AFTER UPDATE ON "pf_secret_generation"
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE "pf_secret_generation" SET updated_at = julianday('now') WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS pf_delegation_history_updated_at_trigger
AFTER UPDATE ON "pf_delegation_history"
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE "pf_delegation_history" SET updated_at = julianday('now') WHERE id = NEW.id;
END;
