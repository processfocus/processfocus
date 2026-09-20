ALTER TABLE "pf_public_completion_invitation_attempt" ADD COLUMN "delivery_status" varchar(32);--> statement-breakpoint
ALTER TABLE "pf_public_completion_invitation_attempt" ADD COLUMN "delivery_event_id" varchar(256);--> statement-breakpoint
ALTER TABLE "pf_public_completion_invitation_attempt" ADD COLUMN "delivery_failure_kind" varchar(64);--> statement-breakpoint
ALTER TABLE "pf_public_completion_invitation_attempt" ADD COLUMN "delivery_failure_reason" "citext";
