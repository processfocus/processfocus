ALTER TABLE `pf_invitation` ADD `invitation_status` text(32) DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `pf_invitation` ADD `invitation_source` text(32) DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE `pf_invitation` ADD `invitation_pending_email` text(320);--> statement-breakpoint
ALTER TABLE `pf_invitation` ADD `invitation_accepted_at` real;--> statement-breakpoint
ALTER TABLE `pf_invitation` ADD `invitation_accepted_by_provider` text(64);--> statement-breakpoint
ALTER TABLE `pf_invitation` ADD `invitation_accepted_by_subject` text(256);--> statement-breakpoint
ALTER TABLE `pf_invitation` ADD `accepted_by_provider_user` text(41) REFERENCES pf_provider_user(id);--> statement-breakpoint
ALTER TABLE `pf_invitation` ADD `invitation_legacy_closed_at` real;--> statement-breakpoint
ALTER TABLE `pf_invitation` ADD `invitation_legacy_closure_reason` text(128);--> statement-breakpoint
-- Replace unique-per-email with non-unique email lookup so accepted history
-- can share a Normalized Email with a later pending invitation.
DROP INDEX IF EXISTS `pf_invitation_emailidx_idx`;--> statement-breakpoint
CREATE INDEX `pf_invitation_emailidx_idx` ON `pf_invitation` (`email`) WHERE _deleted = 0;--> statement-breakpoint
CREATE INDEX `pf_invitation_statusidx_idx` ON `pf_invitation` (`invitation_status`) WHERE _deleted = 0;--> statement-breakpoint
-- Normalize emails and seed pending uniqueness for live invitations.
UPDATE `pf_invitation`
SET
  `email` = lower(trim(`email`)),
  `invitation_pending_email` = lower(trim(`email`)),
  `invitation_status` = 'pending',
  `invitation_source` = 'legacy',
  `updated_at` = julianday('now'),
  `updated_by` = 'SYSTEM'
WHERE `_deleted` = 0;--> statement-breakpoint
-- Mark invitations that already match a non-passkey Provider User as
-- legacy-closed without inventing historical acceptance or role assignment.
UPDATE `pf_invitation`
SET
  `invitation_status` = 'legacy_closed',
  `invitation_pending_email` = NULL,
  `accepted_by_provider_user` = (
    SELECT `pu`.`id`
    FROM `pf_provider_user` AS `pu`
    INNER JOIN `pf_user` AS `u` ON `u`.`id` = `pu`.`user_id`
    WHERE `pu`.`_deleted` = 0
      AND `u`.`_deleted` = 0
      AND `u`.`provider` != 'passkey'
      AND lower(trim(`pu`.`email`)) = `pf_invitation`.`email`
    ORDER BY `pu`.`created_at` ASC, `pu`.`id` ASC
    LIMIT 1
  ),
  `invitation_legacy_closed_at` = julianday('now'),
  `invitation_legacy_closure_reason` = 'existing_provider_user',
  `updated_at` = julianday('now'),
  `updated_by` = 'SYSTEM'
WHERE `_deleted` = 0
  AND EXISTS (
    SELECT 1
    FROM `pf_provider_user` AS `pu`
    INNER JOIN `pf_user` AS `u` ON `u`.`id` = `pu`.`user_id`
    WHERE `pu`.`_deleted` = 0
      AND `u`.`_deleted` = 0
      AND `u`.`provider` != 'passkey'
      AND lower(trim(`pu`.`email`)) = `pf_invitation`.`email`
  );--> statement-breakpoint
-- Collapse historically case-variant duplicate pending emails so the pending
-- uniqueness index can be created. Keep the oldest row; soft-delete the rest.
UPDATE `pf_invitation`
SET
  `_deleted` = 1,
  `invitation_pending_email` = NULL,
  `updated_at` = julianday('now'),
  `updated_by` = 'SYSTEM'
WHERE `id` IN (
  SELECT `id` FROM (
    SELECT
      `id`,
      ROW_NUMBER() OVER (
        PARTITION BY `invitation_pending_email`
        ORDER BY `created_at` ASC, `id` ASC
      ) AS `rn`
    FROM `pf_invitation`
    WHERE `_deleted` = 0
      AND `invitation_status` = 'pending'
      AND `invitation_pending_email` IS NOT NULL
  ) AS `ranked`
  WHERE `rn` > 1
);--> statement-breakpoint
-- Pending uniqueness applies only after legacy close and duplicate collapse.
CREATE UNIQUE INDEX `pf_invitation_pendingemailidx_idx` ON `pf_invitation` (`invitation_pending_email`) WHERE _deleted = 0;
