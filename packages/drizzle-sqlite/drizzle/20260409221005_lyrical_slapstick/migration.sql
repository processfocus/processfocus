CREATE TABLE `pf_calendar_period` (
	`id` text(41) PRIMARY KEY NOT NULL,
	`org_unit_id` text(41) NOT NULL,
	`period_kind` text(64) NOT NULL,
	`period_title` text collate nocase NOT NULL,
	`period_start` real NOT NULL,
	`period_end` real NOT NULL,
	`period_active` integer NOT NULL,
	`period_schedule` text,
	`created_at` real DEFAULT (julianday('now')) NOT NULL,
	`updated_at` real DEFAULT (julianday('now')) NOT NULL,
	`created_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`updated_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`_deleted` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`org_unit_id`) REFERENCES `pf_org_unit`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "period_title_length_check" CHECK(length("pf_calendar_period"."period_title") <= 256)
);
--> statement-breakpoint
CREATE INDEX `pf_calendar_period_kinddateidx_idx` ON `pf_calendar_period` (`period_kind`,`period_start`,`period_end`) WHERE _deleted = 0;--> statement-breakpoint
CREATE INDEX `pf_calendar_period_updated_at_id_idx` ON `pf_calendar_period` (`updated_at`,`id`);--> statement-breakpoint
CREATE TABLE `pf_completed_job` (
	`id` text(41) PRIMARY KEY NOT NULL,
	`queue` text(512) NOT NULL,
	`job_id` text(1024) NOT NULL,
	`created_at` real DEFAULT (julianday('now')) NOT NULL,
	`updated_at` real DEFAULT (julianday('now')) NOT NULL,
	`created_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`updated_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`_deleted` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pf_completed_job_job_id_ix_idx` ON `pf_completed_job` (`queue`,`job_id`) WHERE _deleted = 0;--> statement-breakpoint
CREATE INDEX `pf_completed_job_updated_at_id_idx` ON `pf_completed_job` (`updated_at`,`id`);--> statement-breakpoint
CREATE TABLE `pf_date_exception` (
	`id` text(41) PRIMARY KEY NOT NULL,
	`org_unit_id` text(41) NOT NULL,
	`exception_date` real NOT NULL,
	`exception_slots` text NOT NULL,
	`exception_note` text collate nocase,
	`created_at` real DEFAULT (julianday('now')) NOT NULL,
	`updated_at` real DEFAULT (julianday('now')) NOT NULL,
	`created_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`updated_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`_deleted` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`org_unit_id`) REFERENCES `pf_org_unit`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pf_date_exception_orgunitdateidx_idx` ON `pf_date_exception` (`org_unit_id`,`exception_date`) WHERE _deleted = 0;--> statement-breakpoint
CREATE INDEX `pf_date_exception_updated_at_id_idx` ON `pf_date_exception` (`updated_at`,`id`);--> statement-breakpoint
CREATE TABLE `pf_document_store` (
	`id` text(41) PRIMARY KEY NOT NULL,
	`org_unit_id` text(41) NOT NULL,
	`name` text collate nocase NOT NULL,
	`path` text(2048) NOT NULL,
	`accepted_types` text,
	`size_limit` integer,
	`created_at` real DEFAULT (julianday('now')) NOT NULL,
	`updated_at` real DEFAULT (julianday('now')) NOT NULL,
	`created_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`updated_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`_deleted` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`org_unit_id`) REFERENCES `pf_org_unit`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "name_length_check" CHECK(length("pf_document_store"."name") <= 1024)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pf_document_store_pathidx_idx` ON `pf_document_store` (`path`) WHERE _deleted = 0;--> statement-breakpoint
CREATE INDEX `pf_document_store_updated_at_id_idx` ON `pf_document_store` (`updated_at`,`id`);--> statement-breakpoint
CREATE TABLE `pf_file` (
	`id` text(41) PRIMARY KEY NOT NULL,
	`document_store_id` text(41) NOT NULL,
	`file_size` integer,
	`media_kind` text(256),
	`upload_pending` integer DEFAULT true NOT NULL,
	`created_at` real DEFAULT (julianday('now')) NOT NULL,
	`updated_at` real DEFAULT (julianday('now')) NOT NULL,
	`created_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`updated_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`_deleted` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`document_store_id`) REFERENCES `pf_document_store`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `pf_file_updated_at_id_idx` ON `pf_file` (`updated_at`,`id`);--> statement-breakpoint
CREATE TABLE `pf_flow` (
	`id` text(41) PRIMARY KEY NOT NULL,
	`flow_key` text(128) NOT NULL,
	`source_step` text(41) NOT NULL,
	`target_step` text(41) NOT NULL,
	`condition` text collate nocase,
	`schedule` text collate nocase,
	`fallback_branch` integer DEFAULT false NOT NULL,
	`error_branch` integer DEFAULT false NOT NULL,
	`error_tags` text,
	`created_at` real DEFAULT (julianday('now')) NOT NULL,
	`updated_at` real DEFAULT (julianday('now')) NOT NULL,
	`created_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`updated_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`_deleted` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`source_step`) REFERENCES `pf_step`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_step`) REFERENCES `pf_step`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `pf_flow_sourcetargetidx_idx` ON `pf_flow` (`source_step`,`target_step`) WHERE _deleted = 0;--> statement-breakpoint
CREATE UNIQUE INDEX `pf_flow_flowkeyidx_idx` ON `pf_flow` (`flow_key`) WHERE _deleted = 0;--> statement-breakpoint
CREATE INDEX `pf_flow_updated_at_id_idx` ON `pf_flow` (`updated_at`,`id`);--> statement-breakpoint
CREATE TABLE `pf_holiday_instance` (
	`id` text(41) PRIMARY KEY NOT NULL,
	`org_unit_id` text(41) NOT NULL,
	`holiday_title` text collate nocase NOT NULL,
	`holiday_rule` text NOT NULL,
	`holiday_date` real,
	`created_at` real DEFAULT (julianday('now')) NOT NULL,
	`updated_at` real DEFAULT (julianday('now')) NOT NULL,
	`created_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`updated_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`_deleted` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`org_unit_id`) REFERENCES `pf_org_unit`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "holiday_title_length_check" CHECK(length("pf_holiday_instance"."holiday_title") <= 256)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pf_holiday_instance_orgunittitleidx_idx` ON `pf_holiday_instance` (`org_unit_id`,`holiday_title`) WHERE _deleted = 0;--> statement-breakpoint
CREATE INDEX `pf_holiday_instance_updated_at_id_idx` ON `pf_holiday_instance` (`updated_at`,`id`);--> statement-breakpoint
CREATE TABLE `pf_invitation` (
	`id` text(41) PRIMARY KEY NOT NULL,
	`invitation_id` text(128) NOT NULL,
	`email` text(320) NOT NULL,
	`created_at` real DEFAULT (julianday('now')) NOT NULL,
	`updated_at` real DEFAULT (julianday('now')) NOT NULL,
	`created_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`updated_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`_deleted` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pf_invitation_invitationididx_idx` ON `pf_invitation` (`invitation_id`) WHERE _deleted = 0;--> statement-breakpoint
CREATE UNIQUE INDEX `pf_invitation_emailidx_idx` ON `pf_invitation` (`email`) WHERE _deleted = 0;--> statement-breakpoint
CREATE INDEX `pf_invitation_updated_at_id_idx` ON `pf_invitation` (`updated_at`,`id`);--> statement-breakpoint
CREATE TABLE `pf_invitation_role` (
	`id` text(41) PRIMARY KEY NOT NULL,
	`invitation_id` text(41) NOT NULL,
	`role_id` text(41) NOT NULL,
	`created_at` real DEFAULT (julianday('now')) NOT NULL,
	`updated_at` real DEFAULT (julianday('now')) NOT NULL,
	`created_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`updated_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`_deleted` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`invitation_id`) REFERENCES `pf_invitation`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`role_id`) REFERENCES `pf_role`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pf_invitation_role_invitationroleidx_idx` ON `pf_invitation_role` (`invitation_id`,`role_id`) WHERE _deleted = 0;--> statement-breakpoint
CREATE INDEX `pf_invitation_role_updated_at_id_idx` ON `pf_invitation_role` (`updated_at`,`id`);--> statement-breakpoint
CREATE TABLE `pf_job_queue` (
	`id` text(41) PRIMARY KEY NOT NULL,
	`queue` text(512) NOT NULL,
	`job_payload` text NOT NULL,
	`job_attempts` integer DEFAULT 0 NOT NULL,
	`job_retry_limit` integer DEFAULT 5 NOT NULL,
	`available_at` real DEFAULT (julianday('now')) NOT NULL,
	`locked_until` real,
	`created_at` real DEFAULT (julianday('now')) NOT NULL,
	`updated_at` real DEFAULT (julianday('now')) NOT NULL,
	`created_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`updated_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`_deleted` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pf_job_queue_ready_idx_idx` ON `pf_job_queue` (`queue`,`locked_until`,`job_attempts`,`available_at`) WHERE _deleted = 0;--> statement-breakpoint
CREATE INDEX `pf_job_queue_updated_at_id_idx` ON `pf_job_queue` (`updated_at`,`id`);--> statement-breakpoint
CREATE TABLE `pf_oauth_client` (
	`id` text(41) PRIMARY KEY NOT NULL,
	`client_id` text(128) NOT NULL,
	`client_secret_hash` text(256) NOT NULL,
	`audience` text(128) NOT NULL,
	`created_at` real DEFAULT (julianday('now')) NOT NULL,
	`updated_at` real DEFAULT (julianday('now')) NOT NULL,
	`created_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`updated_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`_deleted` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pf_oauth_client_clientididx_idx` ON `pf_oauth_client` (`client_id`) WHERE _deleted = 0;--> statement-breakpoint
CREATE INDEX `pf_oauth_client_updated_at_id_idx` ON `pf_oauth_client` (`updated_at`,`id`);--> statement-breakpoint
CREATE TABLE `pf_oauth_provider` (
	`id` text(41) PRIMARY KEY NOT NULL,
	`provider_name` text(64) NOT NULL,
	`provider_config` text NOT NULL,
	`created_at` real DEFAULT (julianday('now')) NOT NULL,
	`updated_at` real DEFAULT (julianday('now')) NOT NULL,
	`created_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`updated_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`_deleted` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pf_oauth_provider_nameidx_idx` ON `pf_oauth_provider` (`provider_name`) WHERE _deleted = 0;--> statement-breakpoint
CREATE INDEX `pf_oauth_provider_updated_at_id_idx` ON `pf_oauth_provider` (`updated_at`,`id`);--> statement-breakpoint
CREATE TABLE `pf_oauth_storage` (
	`id` text(41) PRIMARY KEY NOT NULL,
	`oauth_key` text(2048) NOT NULL,
	`key_kind` text(64) NOT NULL,
	`key_value` text NOT NULL,
	`key_expiry` real,
	`created_at` real DEFAULT (julianday('now')) NOT NULL,
	`updated_at` real DEFAULT (julianday('now')) NOT NULL,
	`created_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`updated_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`_deleted` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pf_oauth_storage_keyidx_idx` ON `pf_oauth_storage` (`oauth_key`);--> statement-breakpoint
CREATE INDEX `pf_oauth_storage_updated_at_id_idx` ON `pf_oauth_storage` (`updated_at`,`id`);--> statement-breakpoint
CREATE TABLE `pf_org_unit` (
	`id` text(41) PRIMARY KEY NOT NULL,
	`name` text collate nocase NOT NULL,
	`org_unit_level` text(64) NOT NULL,
	`parent_org_unit` text(41),
	`path` text(2048) NOT NULL,
	`acronym` text collate nocase,
	`timezone` text(64) DEFAULT 'UTC' NOT NULL,
	`start_day_of_week` integer DEFAULT 0,
	`created_at` real DEFAULT (julianday('now')) NOT NULL,
	`updated_at` real DEFAULT (julianday('now')) NOT NULL,
	`created_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`updated_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`_deleted` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`parent_org_unit`) REFERENCES `pf_org_unit`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "name_length_check" CHECK(length("pf_org_unit"."name") <= 1024),
	CONSTRAINT "acronym_length_check" CHECK(length("pf_org_unit"."acronym") <= 64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pf_org_unit_pathidx_idx` ON `pf_org_unit` (`path`) WHERE _deleted = 0;--> statement-breakpoint
CREATE INDEX `pf_org_unit_updated_at_id_idx` ON `pf_org_unit` (`updated_at`,`id`);--> statement-breakpoint
CREATE TABLE `pf_permitted_client_email` (
	`id` text(41) PRIMARY KEY NOT NULL,
	`oauth_client_id` text(41) NOT NULL,
	`email` text(320) NOT NULL,
	`created_at` real DEFAULT (julianday('now')) NOT NULL,
	`updated_at` real DEFAULT (julianday('now')) NOT NULL,
	`created_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`updated_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`_deleted` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`oauth_client_id`) REFERENCES `pf_oauth_client`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pf_permitted_client_email_oauthclientemailidx_idx` ON `pf_permitted_client_email` (`oauth_client_id`,`email`) WHERE _deleted = 0;--> statement-breakpoint
CREATE INDEX `pf_permitted_client_email_updated_at_id_idx` ON `pf_permitted_client_email` (`updated_at`,`id`);--> statement-breakpoint
CREATE TABLE `pf_permitted_client_role` (
	`id` text(41) PRIMARY KEY NOT NULL,
	`oauth_client_id` text(41) NOT NULL,
	`role_id` text(41) NOT NULL,
	`created_at` real DEFAULT (julianday('now')) NOT NULL,
	`updated_at` real DEFAULT (julianday('now')) NOT NULL,
	`created_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`updated_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`_deleted` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`oauth_client_id`) REFERENCES `pf_oauth_client`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`role_id`) REFERENCES `pf_role`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pf_permitted_client_role_oauthclientroleidx_idx` ON `pf_permitted_client_role` (`oauth_client_id`,`role_id`) WHERE _deleted = 0;--> statement-breakpoint
CREATE INDEX `pf_permitted_client_role_updated_at_id_idx` ON `pf_permitted_client_role` (`updated_at`,`id`);--> statement-breakpoint
CREATE TABLE `pf_permitted_role` (
	`id` text(41) PRIMARY KEY NOT NULL,
	`provider_user_id` text(41) NOT NULL,
	`role_id` text(41) NOT NULL,
	`created_at` real DEFAULT (julianday('now')) NOT NULL,
	`updated_at` real DEFAULT (julianday('now')) NOT NULL,
	`created_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`updated_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`_deleted` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`provider_user_id`) REFERENCES `pf_provider_user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`role_id`) REFERENCES `pf_role`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pf_permitted_role_provideruserroleidx_idx` ON `pf_permitted_role` (`provider_user_id`,`role_id`) WHERE _deleted = 0;--> statement-breakpoint
CREATE INDEX `pf_permitted_role_updated_at_id_idx` ON `pf_permitted_role` (`updated_at`,`id`);--> statement-breakpoint
CREATE TABLE `pf_phase` (
	`id` text(41) PRIMARY KEY NOT NULL,
	`process_id` text(41) NOT NULL,
	`name` text collate nocase NOT NULL,
	`path` text(2048) NOT NULL,
	`phase_order` integer NOT NULL,
	`created_at` real DEFAULT (julianday('now')) NOT NULL,
	`updated_at` real DEFAULT (julianday('now')) NOT NULL,
	`created_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`updated_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`_deleted` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`process_id`) REFERENCES `pf_process`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "name_length_check" CHECK(length("pf_phase"."name") <= 1024)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pf_phase_pathidx_idx` ON `pf_phase` (`path`) WHERE _deleted = 0;--> statement-breakpoint
CREATE INDEX `pf_phase_updated_at_id_idx` ON `pf_phase` (`updated_at`,`id`);--> statement-breakpoint
CREATE TABLE `pf_process` (
	`id` text(41) PRIMARY KEY NOT NULL,
	`org_unit_id` text(41) NOT NULL,
	`name` text collate nocase NOT NULL,
	`path` text(2048) NOT NULL,
	`purpose` text collate nocase NOT NULL,
	`sla_value` integer,
	`sla_unit` text(16),
	`sla_warning` integer,
	`created_at` real DEFAULT (julianday('now')) NOT NULL,
	`updated_at` real DEFAULT (julianday('now')) NOT NULL,
	`created_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`updated_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`_deleted` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`org_unit_id`) REFERENCES `pf_org_unit`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "name_length_check" CHECK(length("pf_process"."name") <= 1024)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pf_process_pathidx_idx` ON `pf_process` (`path`) WHERE _deleted = 0;--> statement-breakpoint
CREATE INDEX `pf_process_updated_at_id_idx` ON `pf_process` (`updated_at`,`id`);--> statement-breakpoint
CREATE TABLE `pf_process_execution` (
	`id` text(41) PRIMARY KEY NOT NULL,
	`process_state_id` text(41) NOT NULL,
	`finished_at` real,
	`business_duration` integer,
	`abandoned_at` real,
	`abandoned_reason` text collate nocase,
	`created_at` real DEFAULT (julianday('now')) NOT NULL,
	`updated_at` real DEFAULT (julianday('now')) NOT NULL,
	`created_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`updated_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`_deleted` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`process_state_id`) REFERENCES `pf_process_state`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `pf_process_execution_updated_at_id_idx` ON `pf_process_execution` (`updated_at`,`id`);--> statement-breakpoint
CREATE TABLE `pf_process_state` (
	`id` text(41) PRIMARY KEY NOT NULL,
	`process_id` text(41) NOT NULL,
	`start_step` text(41) NOT NULL,
	`state` text NOT NULL,
	`started_by_user` text(41),
	`created_at` real DEFAULT (julianday('now')) NOT NULL,
	`updated_at` real DEFAULT (julianday('now')) NOT NULL,
	`created_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`updated_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`_deleted` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`process_id`) REFERENCES `pf_process`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`start_step`) REFERENCES `pf_step`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`started_by_user`) REFERENCES `pf_user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `pf_process_state_updated_at_id_idx` ON `pf_process_state` (`updated_at`,`id`);--> statement-breakpoint
CREATE TABLE `pf_provider_user` (
	`id` text(41) PRIMARY KEY NOT NULL,
	`user_id` text(41) NOT NULL,
	`email` text(320) NOT NULL,
	`name` text collate nocase NOT NULL,
	`first_name` text collate nocase NOT NULL,
	`last_name` text collate nocase NOT NULL,
	`picture` text(1024) NOT NULL,
	`locale` text(35) NOT NULL,
	`org_unit_id` text(41) NOT NULL,
	`created_at` real DEFAULT (julianday('now')) NOT NULL,
	`updated_at` real DEFAULT (julianday('now')) NOT NULL,
	`created_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`updated_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`_deleted` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `pf_user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_unit_id`) REFERENCES `pf_org_unit`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "name_length_check" CHECK(length("pf_provider_user"."name") <= 1024),
	CONSTRAINT "first_name_length_check" CHECK(length("pf_provider_user"."first_name") <= 128),
	CONSTRAINT "last_name_length_check" CHECK(length("pf_provider_user"."last_name") <= 128)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pf_provider_user_emailidx_idx` ON `pf_provider_user` (`email`) WHERE _deleted = 0;--> statement-breakpoint
CREATE UNIQUE INDEX `pf_provider_user_user_unique_idx` ON `pf_provider_user` (`user_id`) WHERE _deleted = 0;--> statement-breakpoint
CREATE INDEX `pf_provider_user_updated_at_id_idx` ON `pf_provider_user` (`updated_at`,`id`);--> statement-breakpoint
CREATE TABLE `pf_provider_user_role` (
	`id` text(41) PRIMARY KEY NOT NULL,
	`provider_user_id` text(41) NOT NULL,
	`role_id` text(41) NOT NULL,
	`created_at` real DEFAULT (julianday('now')) NOT NULL,
	`updated_at` real DEFAULT (julianday('now')) NOT NULL,
	`created_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`updated_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`_deleted` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`provider_user_id`) REFERENCES `pf_provider_user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`role_id`) REFERENCES `pf_role`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pf_provider_user_role_provideruserroleidx_idx` ON `pf_provider_user_role` (`provider_user_id`,`role_id`) WHERE _deleted = 0;--> statement-breakpoint
CREATE INDEX `pf_provider_user_role_updated_at_id_idx` ON `pf_provider_user_role` (`updated_at`,`id`);--> statement-breakpoint
CREATE TABLE `pf_role` (
	`id` text(41) PRIMARY KEY NOT NULL,
	`org_unit_id` text(41) NOT NULL,
	`name` text collate nocase NOT NULL,
	`path` text(2048) NOT NULL,
	`created_at` real DEFAULT (julianday('now')) NOT NULL,
	`updated_at` real DEFAULT (julianday('now')) NOT NULL,
	`created_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`updated_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`_deleted` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`org_unit_id`) REFERENCES `pf_org_unit`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "name_length_check" CHECK(length("pf_role"."name") <= 1024)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pf_role_pathidx_idx` ON `pf_role` (`path`) WHERE _deleted = 0;--> statement-breakpoint
CREATE UNIQUE INDEX `pf_role_orgunitunameidx_idx` ON `pf_role` (`org_unit_id`,`name`) WHERE _deleted = 0;--> statement-breakpoint
CREATE INDEX `pf_role_updated_at_id_idx` ON `pf_role` (`updated_at`,`id`);--> statement-breakpoint
CREATE TABLE `pf_role_responsibility` (
	`id` text(41) PRIMARY KEY NOT NULL,
	`process_id` text(41) NOT NULL,
	`role_id` text(41) NOT NULL,
	`responsibility` text collate nocase NOT NULL,
	`responsibility_order` integer NOT NULL,
	`created_at` real DEFAULT (julianday('now')) NOT NULL,
	`updated_at` real DEFAULT (julianday('now')) NOT NULL,
	`created_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`updated_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`_deleted` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`process_id`) REFERENCES `pf_process`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`role_id`) REFERENCES `pf_role`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pf_role_responsibility_processroleidx_idx` ON `pf_role_responsibility` (`process_id`,`role_id`) WHERE _deleted = 0;--> statement-breakpoint
CREATE INDEX `pf_role_responsibility_updated_at_id_idx` ON `pf_role_responsibility` (`updated_at`,`id`);--> statement-breakpoint
CREATE TABLE `pf_scheduled_flow` (
	`id` text(41) PRIMARY KEY NOT NULL,
	`process_execution_id` text(41) NOT NULL,
	`source_step` text(41) NOT NULL,
	`target_step` text(41),
	`scheduled_at` real,
	`for_each_barrier` integer DEFAULT false NOT NULL,
	`created_at` real DEFAULT (julianday('now')) NOT NULL,
	`updated_at` real DEFAULT (julianday('now')) NOT NULL,
	`created_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`updated_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`_deleted` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`process_execution_id`) REFERENCES `pf_process_execution`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_step`) REFERENCES `pf_step`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_step`) REFERENCES `pf_step`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `pf_scheduled_flow_updated_at_id_idx` ON `pf_scheduled_flow` (`updated_at`,`id`);--> statement-breakpoint
CREATE TABLE `pf_step` (
	`id` text(41) PRIMARY KEY NOT NULL,
	`name` text collate nocase NOT NULL,
	`path` text(2048) NOT NULL,
	`purpose` text collate nocase NOT NULL,
	`process_id` text(41) NOT NULL,
	`role_id` text(41),
	`form_fields` integer,
	`phase_id` text(41),
	`sla_value` integer,
	`sla_unit` text(16),
	`sla_warning` integer,
	`has_for_each` integer DEFAULT false NOT NULL,
	`embedded` integer DEFAULT false NOT NULL,
	`retry_limit` integer,
	`created_at` real DEFAULT (julianday('now')) NOT NULL,
	`updated_at` real DEFAULT (julianday('now')) NOT NULL,
	`created_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`updated_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`_deleted` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`process_id`) REFERENCES `pf_process`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`role_id`) REFERENCES `pf_role`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`phase_id`) REFERENCES `pf_phase`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "name_length_check" CHECK(length("pf_step"."name") <= 1024)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pf_step_pathidx_idx` ON `pf_step` (`path`) WHERE _deleted = 0;--> statement-breakpoint
CREATE INDEX `pf_step_updated_at_id_idx` ON `pf_step` (`updated_at`,`id`);--> statement-breakpoint
CREATE TABLE `pf_step_document_store` (
	`id` text(41) PRIMARY KEY NOT NULL,
	`step_id` text(41) NOT NULL,
	`document_store_id` text(41) NOT NULL,
	`created_at` real DEFAULT (julianday('now')) NOT NULL,
	`updated_at` real DEFAULT (julianday('now')) NOT NULL,
	`created_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`updated_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`_deleted` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`step_id`) REFERENCES `pf_step`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_store_id`) REFERENCES `pf_document_store`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pf_step_document_store_stepdocstoreidx_idx` ON `pf_step_document_store` (`step_id`,`document_store_id`) WHERE _deleted = 0;--> statement-breakpoint
CREATE INDEX `pf_step_document_store_updated_at_id_idx` ON `pf_step_document_store` (`updated_at`,`id`);--> statement-breakpoint
CREATE TABLE `pf_to_do` (
	`id` text(41) PRIMARY KEY NOT NULL,
	`process_execution_id` text(41) NOT NULL,
	`flow_id` text(41) NOT NULL,
	`completed_by_user` text(41),
	`assigned_to_provider_user` text(41),
	`business_duration` integer,
	`sla_target_at` real,
	`sla_warning_at` real,
	`failure_reason` text collate nocase,
	`item_data` text,
	`barrier_scheduled_flow_id` text(41),
	`created_at` real DEFAULT (julianday('now')) NOT NULL,
	`updated_at` real DEFAULT (julianday('now')) NOT NULL,
	`created_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`updated_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`_deleted` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`process_execution_id`) REFERENCES `pf_process_execution`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`flow_id`) REFERENCES `pf_flow`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`completed_by_user`) REFERENCES `pf_user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assigned_to_provider_user`) REFERENCES `pf_provider_user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `pf_to_do_updated_at_id_idx` ON `pf_to_do` (`updated_at`,`id`);--> statement-breakpoint
CREATE TABLE `pf_user` (
	`id` text(41) PRIMARY KEY NOT NULL,
	`provider` text(128) NOT NULL,
	`sub` text(256) NOT NULL,
	`last_logged_in` real NOT NULL,
	`created_at` real DEFAULT (julianday('now')) NOT NULL,
	`updated_at` real DEFAULT (julianday('now')) NOT NULL,
	`created_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`updated_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`_deleted` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pf_user_uniquesub_idx` ON `pf_user` (`provider`,`sub`) WHERE _deleted = 0;--> statement-breakpoint
CREATE INDEX `pf_user_updated_at_id_idx` ON `pf_user` (`updated_at`,`id`);--> statement-breakpoint
CREATE TABLE `pf_user_settings` (
	`id` text(41) PRIMARY KEY NOT NULL,
	`user_id` text(41) NOT NULL,
	`notification_preference` text NOT NULL,
	`created_at` real DEFAULT (julianday('now')) NOT NULL,
	`updated_at` real DEFAULT (julianday('now')) NOT NULL,
	`created_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`updated_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`_deleted` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `pf_user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pf_user_settings_user_unique_idx` ON `pf_user_settings` (`user_id`) WHERE _deleted = 0;--> statement-breakpoint
CREATE INDEX `pf_user_settings_updated_at_id_idx` ON `pf_user_settings` (`updated_at`,`id`);--> statement-breakpoint
CREATE TABLE `pf_weekly_schedule` (
	`id` text(41) PRIMARY KEY NOT NULL,
	`org_unit_id` text(41) NOT NULL,
	`day_of_week` integer NOT NULL,
	`time_ranges` text NOT NULL,
	`created_at` real DEFAULT (julianday('now')) NOT NULL,
	`updated_at` real DEFAULT (julianday('now')) NOT NULL,
	`created_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`updated_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`_deleted` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`org_unit_id`) REFERENCES `pf_org_unit`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pf_weekly_schedule_orgunitdayidx_idx` ON `pf_weekly_schedule` (`org_unit_id`,`day_of_week`) WHERE _deleted = 0;--> statement-breakpoint
CREATE INDEX `pf_weekly_schedule_updated_at_id_idx` ON `pf_weekly_schedule` (`updated_at`,`id`);--> statement-breakpoint
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
CREATE VIEW `pf_process_its_start_step` AS 
  select
    id,
    (select pf_step.id from pf_step
    join pf_step_its_can_start_process on pf_step.id = pf_step_its_can_start_process.id
    where pf_step.process_id = pf_process.id
    and pf_step_its_can_start_process.can_start_process = 1
    and pf_step._deleted = false
    limit 1) as start_step
  from pf_process
;--> statement-breakpoint
CREATE VIEW `pf_process_state_its_is_draft` AS 
  select
    id,
    not exists (select 1 from pf_process_execution where pf_process_execution.process_state_id = pf_process_state.id and pf_process_execution._deleted = false) as is_draft
  from pf_process_state
;--> statement-breakpoint
CREATE VIEW `pf_step_its_can_start_process` AS 
  select
    id,
    not exists (select 1 from pf_flow where pf_flow.target_step = pf_step.id and pf_flow._deleted = false) as can_start_process
  from pf_step
;
