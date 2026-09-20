CREATE TABLE "pf_public_completion_invitation_attempt" (
	"id" varchar(41) PRIMARY KEY NOT NULL,
	"to_do_id" varchar(41) NOT NULL,
	"email" varchar(320) NOT NULL,
	"provider_message_id" varchar(256),
	"provider_sent_to" "citext",
	"created_at" timestamp without time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp without time zone DEFAULT now() NOT NULL,
	"created_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"updated_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"_deleted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pf_public_completion_invitation_attempt" ADD CONSTRAINT "pf_public_completion_invitation_attempt_to_do_id_pf_to_do_id_fk" FOREIGN KEY ("to_do_id") REFERENCES "public"."pf_to_do"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pf_public_completion_invitation_attempt_todoidx_idx" ON "pf_public_completion_invitation_attempt" USING btree ("to_do_id") WHERE _deleted = false;--> statement-breakpoint
CREATE INDEX "pf_public_completion_invitation_attempt_updated_at_id_idx" ON "pf_public_completion_invitation_attempt" USING btree ("updated_at","id");
--> statement-breakpoint
CREATE TRIGGER pf_public_completion_invitation_attempt_updated_at_trigger
BEFORE UPDATE ON "pf_public_completion_invitation_attempt"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
