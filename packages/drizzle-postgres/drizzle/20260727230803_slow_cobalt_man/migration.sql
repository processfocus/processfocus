CREATE TABLE "pf_registration_session" (
	"id" varchar(41) PRIMARY KEY,
	"registration_session_token_hash" varchar(64) NOT NULL,
	"invitation_id" varchar(41) NOT NULL,
	"registration_link_generation" integer NOT NULL,
	"registration_session_expires_at" timestamp without time zone NOT NULL,
	"created_at" timestamp without time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp without time zone DEFAULT now() NOT NULL,
	"created_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"updated_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"_deleted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX "pf_registration_session_invitationidx_idx" ON "pf_registration_session" ("invitation_id") WHERE _deleted = false;--> statement-breakpoint
CREATE UNIQUE INDEX "pf_registration_session_tokenhashidx_idx" ON "pf_registration_session" ("registration_session_token_hash") WHERE _deleted = false;--> statement-breakpoint
CREATE INDEX "pf_registration_session_updated_at_id_idx" ON "pf_registration_session" ("updated_at","id");--> statement-breakpoint
ALTER TABLE "pf_registration_session" ADD CONSTRAINT "pf_registration_session_invitation_id_pf_invitation_id_fkey" FOREIGN KEY ("invitation_id") REFERENCES "pf_invitation"("id");
--> statement-breakpoint
CREATE TRIGGER pf_registration_session_updated_at_trigger
BEFORE UPDATE ON "pf_registration_session"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
