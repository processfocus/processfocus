CREATE TABLE "pf_delegation" (
	"id" varchar(41) PRIMARY KEY,
	"owner_provider_user" varchar(41) NOT NULL,
	"delegation_name" varchar(128) NOT NULL,
	"active_delegation_name" varchar(128),
	"secret_revoked_at" timestamp without time zone,
	"created_at" timestamp without time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp without time zone DEFAULT now() NOT NULL,
	"created_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"updated_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"_deleted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pf_delegation_history" (
	"id" varchar(41) PRIMARY KEY,
	"delegation_id" varchar(41) NOT NULL,
	"secret_generation_id" varchar(41) NOT NULL,
	"actor_provider_user" varchar(41) NOT NULL,
	"delegation_event" varchar(32) NOT NULL,
	"secret_issued_at" timestamp without time zone NOT NULL,
	"created_at" timestamp without time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp without time zone DEFAULT now() NOT NULL,
	"created_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"updated_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"_deleted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pf_secret_generation" (
	"id" varchar(41) PRIMARY KEY,
	"delegation_id" varchar(41) NOT NULL,
	"secret_verifier" varchar(64) NOT NULL,
	"secret_issued_at" timestamp without time zone NOT NULL,
	"secret_expires_at" timestamp without time zone NOT NULL,
	"secret_revoked_at" timestamp without time zone,
	"secret_last_used_at" timestamp without time zone,
	"created_at" timestamp without time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp without time zone DEFAULT now() NOT NULL,
	"created_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"updated_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"_deleted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "pf_delegation_ownernameidx_idx" ON "pf_delegation" ("owner_provider_user","active_delegation_name") WHERE _deleted = false;--> statement-breakpoint
CREATE INDEX "pf_delegation_updated_at_id_idx" ON "pf_delegation" ("updated_at","id");--> statement-breakpoint
CREATE INDEX "pf_delegation_history_updated_at_id_idx" ON "pf_delegation_history" ("updated_at","id");--> statement-breakpoint
CREATE INDEX "pf_secret_generation_delegationidx_idx" ON "pf_secret_generation" ("delegation_id") WHERE _deleted = false;--> statement-breakpoint
CREATE UNIQUE INDEX "pf_secret_generation_verifieridx_idx" ON "pf_secret_generation" ("secret_verifier") WHERE _deleted = false;--> statement-breakpoint
CREATE INDEX "pf_secret_generation_updated_at_id_idx" ON "pf_secret_generation" ("updated_at","id");--> statement-breakpoint
ALTER TABLE "pf_delegation" ADD CONSTRAINT "pf_delegation_owner_provider_user_pf_provider_user_id_fkey" FOREIGN KEY ("owner_provider_user") REFERENCES "pf_provider_user"("id");--> statement-breakpoint
ALTER TABLE "pf_delegation_history" ADD CONSTRAINT "pf_delegation_history_delegation_id_pf_delegation_id_fkey" FOREIGN KEY ("delegation_id") REFERENCES "pf_delegation"("id");--> statement-breakpoint
ALTER TABLE "pf_delegation_history" ADD CONSTRAINT "pf_delegation_history_2QZ7I50llp5D_fkey" FOREIGN KEY ("secret_generation_id") REFERENCES "pf_secret_generation"("id");--> statement-breakpoint
ALTER TABLE "pf_delegation_history" ADD CONSTRAINT "pf_delegation_history_EZXbuAGybiCJ_fkey" FOREIGN KEY ("actor_provider_user") REFERENCES "pf_provider_user"("id");--> statement-breakpoint
ALTER TABLE "pf_secret_generation" ADD CONSTRAINT "pf_secret_generation_delegation_id_pf_delegation_id_fkey" FOREIGN KEY ("delegation_id") REFERENCES "pf_delegation"("id");
--> statement-breakpoint
CREATE TRIGGER pf_delegation_updated_at_trigger
BEFORE UPDATE ON "pf_delegation"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER pf_secret_generation_updated_at_trigger
BEFORE UPDATE ON "pf_secret_generation"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER pf_delegation_history_updated_at_trigger
BEFORE UPDATE ON "pf_delegation_history"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
