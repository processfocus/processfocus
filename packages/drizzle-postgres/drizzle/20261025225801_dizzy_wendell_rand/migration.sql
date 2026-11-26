CREATE TABLE "pf_task_deadline" (
	"id" varchar(41) PRIMARY KEY,
	"owner_to_do" varchar(41) NOT NULL,
	"flow_id" varchar(41) NOT NULL,
	"deadline_name" varchar(100) NOT NULL,
	"scheduled_at" timestamp without time zone NOT NULL,
	"triggered_at" timestamp without time zone,
	"disarmed_at" timestamp without time zone,
	"created_at" timestamp without time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp without time zone DEFAULT now() NOT NULL,
	"created_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"updated_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"_deleted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pf_flow" ADD COLUMN "deadline_name" varchar(100);--> statement-breakpoint
CREATE UNIQUE INDEX "pf_task_deadline_activationname_idx" ON "pf_task_deadline" ("owner_to_do","deadline_name") WHERE _deleted = false;--> statement-breakpoint
CREATE INDEX "pf_task_deadline_updated_at_id_idx" ON "pf_task_deadline" ("updated_at","id");--> statement-breakpoint
ALTER TABLE "pf_task_deadline" ADD CONSTRAINT "pf_task_deadline_owner_to_do_pf_to_do_id_fkey" FOREIGN KEY ("owner_to_do") REFERENCES "pf_to_do"("id");--> statement-breakpoint
ALTER TABLE "pf_task_deadline" ADD CONSTRAINT "pf_task_deadline_flow_id_pf_flow_id_fkey" FOREIGN KEY ("flow_id") REFERENCES "pf_flow"("id");