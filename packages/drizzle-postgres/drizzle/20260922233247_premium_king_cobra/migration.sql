CREATE TABLE "pf_not_started_job" (
	"id" varchar(41) PRIMARY KEY,
	"queue" varchar(512) NOT NULL,
	"job_id" varchar(1024) NOT NULL,
	"not_started_reason" citext NOT NULL,
	"created_at" timestamp without time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp without time zone DEFAULT now() NOT NULL,
	"created_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"updated_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"_deleted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pf_process_execution" ADD COLUMN "not_started_reason" citext;--> statement-breakpoint
ALTER TABLE "pf_to_do" ADD COLUMN "not_started_reason" citext;--> statement-breakpoint
CREATE UNIQUE INDEX "pf_not_started_job_job_id_ix_idx" ON "pf_not_started_job" ("queue","job_id") WHERE _deleted = false;--> statement-breakpoint
CREATE INDEX "pf_not_started_job_updated_at_id_idx" ON "pf_not_started_job" ("updated_at","id");
--> statement-breakpoint
CREATE TRIGGER pf_not_started_job_updated_at_trigger
BEFORE UPDATE ON "pf_not_started_job"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
