CREATE TABLE "pf_external_credential_handoff" (
	"id" varchar(41) PRIMARY KEY,
	"credential_reference" varchar(64) NOT NULL,
	"organisation_scope" varchar(256) NOT NULL,
	"email" varchar(320) NOT NULL,
	"process_execution_id" varchar(41) NOT NULL,
	"to_do_id" varchar(41) NOT NULL,
	"provider" varchar(128) NOT NULL,
	"resource_id" varchar(2048) NOT NULL,
	"encryption_nonce" varchar(16) NOT NULL,
	"authentication_tag" varchar(32) NOT NULL,
	"encrypted_credential" citext NOT NULL,
	"encryption_version" integer NOT NULL,
	"expires_at" timestamp without time zone NOT NULL,
	"created_at" timestamp without time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp without time zone DEFAULT now() NOT NULL,
	"created_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"updated_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"_deleted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX "pf_external_credential_handoff_expiryidx_idx" ON "pf_external_credential_handoff" ("expires_at") WHERE _deleted = false;--> statement-breakpoint
CREATE UNIQUE INDEX "pf_external_credential_handoff_referenceidx_idx" ON "pf_external_credential_handoff" ("credential_reference") WHERE _deleted = false;--> statement-breakpoint
CREATE INDEX "pf_external_credential_handoff_updated_at_id_idx" ON "pf_external_credential_handoff" ("updated_at","id");--> statement-breakpoint
ALTER TABLE "pf_external_credential_handoff" ADD CONSTRAINT "pf_external_credential_handoff_NA13TnirA076_fkey" FOREIGN KEY ("process_execution_id") REFERENCES "pf_process_execution"("id");--> statement-breakpoint
ALTER TABLE "pf_external_credential_handoff" ADD CONSTRAINT "pf_external_credential_handoff_to_do_id_pf_to_do_id_fkey" FOREIGN KEY ("to_do_id") REFERENCES "pf_to_do"("id");