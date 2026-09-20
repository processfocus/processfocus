ALTER TABLE `pf_invitation` ADD `registration_token_hash` text(64);--> statement-breakpoint
ALTER TABLE `pf_invitation` ADD `registration_encryption_version` integer;--> statement-breakpoint
ALTER TABLE `pf_invitation` ADD `registration_encryption_nonce` text(24);--> statement-breakpoint
ALTER TABLE `pf_invitation` ADD `registration_authentication_tag` text(32);--> statement-breakpoint
ALTER TABLE `pf_invitation` ADD `registration_encrypted_token` text collate nocase;--> statement-breakpoint
ALTER TABLE `pf_invitation` ADD `registration_link_expires_at` real;--> statement-breakpoint
ALTER TABLE `pf_invitation` ADD `registration_link_generated_at` real;--> statement-breakpoint
ALTER TABLE `pf_invitation` ADD `registration_link_generated_by` text(256);--> statement-breakpoint
ALTER TABLE `pf_invitation` ADD `registration_link_revealed_at` real;--> statement-breakpoint
ALTER TABLE `pf_invitation` ADD `registration_link_revealed_by` text(256);--> statement-breakpoint
ALTER TABLE `pf_invitation` ADD `registration_link_revoked_at` real;--> statement-breakpoint
ALTER TABLE `pf_invitation` ADD `registration_link_revoked_by` text(256);--> statement-breakpoint
ALTER TABLE `pf_invitation` ADD `registration_link_generation` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `pf_invitation_registrationtokenhashidx_idx` ON `pf_invitation` (`registration_token_hash`) WHERE _deleted = 0;