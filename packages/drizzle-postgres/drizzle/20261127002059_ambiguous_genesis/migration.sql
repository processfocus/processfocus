CREATE TABLE "pf_mcp_oauth_record" (
	"id" varchar(41) PRIMARY KEY,
	"mcp_partition" varchar(2048) NOT NULL,
	"mcp_record_key" varchar(64) NOT NULL,
	"mcp_revision" varchar(36) NOT NULL,
	"key_value" jsonb NOT NULL,
	"key_expiry" timestamp without time zone,
	"created_at" timestamp without time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp without time zone DEFAULT now() NOT NULL,
	"created_by" text DEFAULT 'SYSTEM' NOT NULL,
	"updated_by" text DEFAULT 'SYSTEM' NOT NULL,
	"_deleted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX "pf_mcp_oauth_record_expiryidx_idx" ON "pf_mcp_oauth_record" ("key_expiry") WHERE _deleted = false;--> statement-breakpoint
CREATE UNIQUE INDEX "pf_mcp_oauth_record_partitionkeyidx_idx" ON "pf_mcp_oauth_record" ("mcp_partition","mcp_record_key") WHERE _deleted = false;--> statement-breakpoint
CREATE INDEX "pf_mcp_oauth_record_updated_at_id_idx" ON "pf_mcp_oauth_record" ("updated_at","id");