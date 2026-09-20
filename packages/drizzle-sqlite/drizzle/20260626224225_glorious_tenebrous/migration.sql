DROP VIEW IF EXISTS `pf_process_its_active_processes`;--> statement-breakpoint
DROP VIEW IF EXISTS `pf_process_its_no_drafts`;--> statement-breakpoint
DROP VIEW IF EXISTS `pf_process_state_its_is_draft`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_pf_process_state` (
	`id` text(41) PRIMARY KEY,
	`process_id` text(41) NOT NULL,
	`start_step` text(41) NOT NULL,
	`state` text NOT NULL,
	`started_by_user` text(41),
	`started_by_external_participant` text(41),
	`started_by_role` text(41),
	`created_at` real DEFAULT (julianday('now')) NOT NULL,
	`updated_at` real DEFAULT (julianday('now')) NOT NULL,
	`created_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`updated_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`_deleted` integer DEFAULT false NOT NULL,
	CONSTRAINT `pf_process_state_process_id_pf_process_id_fk` FOREIGN KEY (`process_id`) REFERENCES `pf_process`(`id`),
	CONSTRAINT `pf_process_state_start_step_pf_step_id_fk` FOREIGN KEY (`start_step`) REFERENCES `pf_step`(`id`),
	CONSTRAINT `pf_process_state_started_by_user_pf_user_id_fk` FOREIGN KEY (`started_by_user`) REFERENCES `pf_user`(`id`),
	CONSTRAINT `pf_process_state_started_by_external_participant_pf_external_participant_id_fk` FOREIGN KEY (`started_by_external_participant`) REFERENCES `pf_external_participant`(`id`),
	CONSTRAINT `pf_process_state_started_by_role_pf_role_id_fk` FOREIGN KEY (`started_by_role`) REFERENCES `pf_role`(`id`),
	CONSTRAINT "single_starter_check" CHECK("started_by_user" is null or "started_by_external_participant" is null)
);
--> statement-breakpoint
INSERT INTO `__new_pf_process_state`(`id`, `process_id`, `start_step`, `state`, `started_by_user`, `started_by_external_participant`, `started_by_role`, `created_at`, `updated_at`, `created_by`, `updated_by`, `_deleted`) SELECT `id`, `process_id`, `start_step`, `state`, `started_by_user`, `started_by_external_participant`, `started_by_role`, `created_at`, `updated_at`, `created_by`, `updated_by`, `_deleted` FROM `pf_process_state`;--> statement-breakpoint
DROP TABLE `pf_process_state`;--> statement-breakpoint
ALTER TABLE `__new_pf_process_state` RENAME TO `pf_process_state`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_pf_to_do` (
	`id` text(41) PRIMARY KEY,
	`process_execution_id` text(41) NOT NULL,
	`flow_id` text(41) NOT NULL,
	`completed_by_user` text(41),
	`completed_by_external_participant` text(41),
	`assigned_to_provider_user` text(41),
	`business_duration` integer,
	`sla_target_at` real,
	`sla_warning_at` real,
	`failure_reason` text collate nocase,
	`correction_required_at` real,
	`correction_failure_reason` text collate nocase,
	`correction_invitation_attempt_id` text(41),
	`item_data` text,
	`barrier_scheduled_flow_id` text(41),
	`completed_by_role` text(41),
	`created_at` real DEFAULT (julianday('now')) NOT NULL,
	`updated_at` real DEFAULT (julianday('now')) NOT NULL,
	`created_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`updated_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`_deleted` integer DEFAULT false NOT NULL,
	CONSTRAINT `pf_to_do_process_execution_id_pf_process_execution_id_fk` FOREIGN KEY (`process_execution_id`) REFERENCES `pf_process_execution`(`id`),
	CONSTRAINT `pf_to_do_flow_id_pf_flow_id_fk` FOREIGN KEY (`flow_id`) REFERENCES `pf_flow`(`id`),
	CONSTRAINT `pf_to_do_completed_by_user_pf_user_id_fk` FOREIGN KEY (`completed_by_user`) REFERENCES `pf_user`(`id`),
	CONSTRAINT `pf_to_do_completed_by_external_participant_pf_external_participant_id_fk` FOREIGN KEY (`completed_by_external_participant`) REFERENCES `pf_external_participant`(`id`),
	CONSTRAINT `pf_to_do_assigned_to_provider_user_pf_provider_user_id_fk` FOREIGN KEY (`assigned_to_provider_user`) REFERENCES `pf_provider_user`(`id`),
	CONSTRAINT `pf_to_do_completed_by_role_pf_role_id_fk` FOREIGN KEY (`completed_by_role`) REFERENCES `pf_role`(`id`),
	CONSTRAINT "single_completer_check" CHECK("completed_by_user" is null or "completed_by_external_participant" is null)
);
--> statement-breakpoint
INSERT INTO `__new_pf_to_do`(`id`, `process_execution_id`, `flow_id`, `completed_by_user`, `completed_by_external_participant`, `assigned_to_provider_user`, `business_duration`, `sla_target_at`, `sla_warning_at`, `failure_reason`, `correction_required_at`, `correction_failure_reason`, `correction_invitation_attempt_id`, `item_data`, `barrier_scheduled_flow_id`, `completed_by_role`, `created_at`, `updated_at`, `created_by`, `updated_by`, `_deleted`) SELECT `id`, `process_execution_id`, `flow_id`, `completed_by_user`, `completed_by_external_participant`, `assigned_to_provider_user`, `business_duration`, `sla_target_at`, `sla_warning_at`, `failure_reason`, `correction_required_at`, `correction_failure_reason`, `correction_invitation_attempt_id`, `item_data`, `barrier_scheduled_flow_id`, `completed_by_role`, `created_at`, `updated_at`, `created_by`, `updated_by`, `_deleted` FROM `pf_to_do`;--> statement-breakpoint
DROP TABLE `pf_to_do`;--> statement-breakpoint
ALTER TABLE `__new_pf_to_do` RENAME TO `pf_to_do`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `pf_process_state_updated_at_id_idx` ON `pf_process_state` (`updated_at`,`id`);--> statement-breakpoint
CREATE INDEX `pf_to_do_updated_at_id_idx` ON `pf_to_do` (`updated_at`,`id`);--> statement-breakpoint
CREATE VIEW `pf_process_its_active_processes` AS 
  select
    pf_process.id,
    count(distinct pf_to_do.id) as active_processes
  from pf_process
  left outer join pf_process_state on pf_process_state.process_id = pf_process.id and pf_process_state._deleted = false
  left outer join pf_process_execution on pf_process_execution.process_state_id = pf_process_state.id and pf_process_execution._deleted = false
  left outer join pf_to_do on pf_to_do.process_execution_id = pf_process_execution.id and pf_to_do._deleted = false
  group by
    pf_process.id
;--> statement-breakpoint
CREATE VIEW `pf_process_its_no_drafts` AS 
  select
    id,
    not exists (select 1 from pf_process_execution
    join pf_process_state on pf_process_execution.process_state_id = pf_process_state.id and pf_process_state._deleted = false
    where pf_process_state.process_id = pf_process.id and pf_process_execution._deleted = false) as no_drafts
  from pf_process
;--> statement-breakpoint
CREATE VIEW `pf_process_state_its_is_draft` AS 
  select
    id,
    not exists (select 1 from pf_process_execution where pf_process_execution.process_state_id = pf_process_state.id and pf_process_execution._deleted = false) as is_draft
  from pf_process_state
;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS pf_process_state_updated_at_trigger
AFTER UPDATE ON "pf_process_state"
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE "pf_process_state" SET updated_at = julianday('now') WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS pf_to_do_updated_at_trigger
AFTER UPDATE ON "pf_to_do"
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE "pf_to_do" SET updated_at = julianday('now') WHERE id = NEW.id;
END;
