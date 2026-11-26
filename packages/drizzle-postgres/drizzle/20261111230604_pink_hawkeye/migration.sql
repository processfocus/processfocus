CREATE TABLE "pf_audit_event" (
	"id" varchar(41) PRIMARY KEY,
	"audit_kind" varchar(16) NOT NULL,
	"occurred_at" timestamp without time zone NOT NULL,
	"audit_details" jsonb NOT NULL,
	"created_at" timestamp without time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp without time zone DEFAULT now() NOT NULL,
	"created_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"updated_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"_deleted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX "pf_audit_event_updated_at_id_idx" ON "pf_audit_event" ("updated_at","id");