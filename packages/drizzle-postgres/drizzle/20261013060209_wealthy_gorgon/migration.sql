CREATE TABLE "pf_process_visibility" (
	"id" varchar(41) PRIMARY KEY,
	"process_id" varchar(41) NOT NULL,
	"replication_scope" varchar(64) NOT NULL,
	"created_at" timestamp without time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp without time zone DEFAULT now() NOT NULL,
	"created_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"updated_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"_deleted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "pf_process_visibility_scopeprocessidx_idx" ON "pf_process_visibility" ("replication_scope","process_id") WHERE _deleted = false;--> statement-breakpoint
CREATE INDEX "pf_process_visibility_updated_at_id_idx" ON "pf_process_visibility" ("updated_at","id");--> statement-breakpoint
ALTER TABLE "pf_process_visibility" ADD CONSTRAINT "pf_process_visibility_process_id_pf_process_id_fkey" FOREIGN KEY ("process_id") REFERENCES "pf_process"("id");