CREATE TABLE "pf_queue_job_lifecycle" (
	"id" varchar(41) PRIMARY KEY,
	"queue" varchar(512) NOT NULL,
	"job_id" varchar(1024) NOT NULL,
	"job_lifecycle" jsonb NOT NULL,
	"terminal_at" timestamp without time zone,
	"created_at" timestamp without time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp without time zone DEFAULT now() NOT NULL,
	"created_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"updated_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"_deleted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pf_process_execution" ADD COLUMN "restart_attempt_id" varchar(36);--> statement-breakpoint
CREATE INDEX "pf_queue_job_lifecycle_terminal_idx_idx" ON "pf_queue_job_lifecycle" ("terminal_at") WHERE _deleted = false;--> statement-breakpoint
CREATE UNIQUE INDEX "pf_queue_job_lifecycle_job_id_ix_idx" ON "pf_queue_job_lifecycle" ("queue","job_id") WHERE _deleted = false;--> statement-breakpoint
CREATE INDEX "pf_queue_job_lifecycle_updated_at_id_idx" ON "pf_queue_job_lifecycle" ("updated_at","id");
--> statement-breakpoint
CREATE TRIGGER pf_queue_job_lifecycle_updated_at_trigger
BEFORE UPDATE ON "pf_queue_job_lifecycle"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
