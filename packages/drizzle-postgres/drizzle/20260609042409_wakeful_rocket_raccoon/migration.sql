ALTER TABLE "pf_to_do" ADD COLUMN "correction_required_at" timestamp without time zone;--> statement-breakpoint
ALTER TABLE "pf_to_do" ADD COLUMN "correction_failure_reason" "citext";--> statement-breakpoint
ALTER TABLE "pf_to_do" ADD COLUMN "correction_invitation_attempt_id" varchar(41);
