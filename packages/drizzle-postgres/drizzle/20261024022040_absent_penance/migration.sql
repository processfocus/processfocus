ALTER TABLE "pf_job_queue" ADD COLUMN "terminal_at" timestamp without time zone;--> statement-breakpoint
ALTER TABLE "pf_job_queue" ADD COLUMN "terminal_reason" citext;--> statement-breakpoint
ALTER TABLE "pf_job_queue" ADD COLUMN "terminal_outcome" varchar(32);--> statement-breakpoint
ALTER TABLE "pf_job_queue" ADD COLUMN "redriven_from" varchar(64);