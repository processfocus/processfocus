ALTER TABLE `pf_public_completion_invitation_attempt` ADD `delivery_status` text(32);--> statement-breakpoint
ALTER TABLE `pf_public_completion_invitation_attempt` ADD `delivery_event_id` text(256);--> statement-breakpoint
ALTER TABLE `pf_public_completion_invitation_attempt` ADD `delivery_failure_kind` text(64);--> statement-breakpoint
ALTER TABLE `pf_public_completion_invitation_attempt` ADD `delivery_failure_reason` text collate nocase;
