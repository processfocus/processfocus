CREATE TABLE "pf_external_participant" (
	"id" varchar(41) PRIMARY KEY NOT NULL,
	"email" varchar(320) NOT NULL,
	"created_at" timestamp without time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp without time zone DEFAULT now() NOT NULL,
	"created_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"updated_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"_deleted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "pf_external_participant_emailidx_idx" ON "pf_external_participant" USING btree ("email") WHERE _deleted = false;
--> statement-breakpoint
CREATE INDEX "pf_external_participant_updated_at_id_idx" ON "pf_external_participant" USING btree ("updated_at","id");
--> statement-breakpoint
ALTER TABLE "pf_process_state" ADD COLUMN "started_by_external_participant" varchar(41);
--> statement-breakpoint
ALTER TABLE "pf_process_state" ADD CONSTRAINT "pf_process_state_started_by_external_participant_pf_external_participant_id_fk" FOREIGN KEY ("started_by_external_participant") REFERENCES "public"."pf_external_participant"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pf_to_do" ADD COLUMN "completed_by_external_participant" varchar(41);
--> statement-breakpoint
ALTER TABLE "pf_to_do" ADD CONSTRAINT "pf_to_do_completed_by_external_participant_pf_external_participant_id_fk" FOREIGN KEY ("completed_by_external_participant") REFERENCES "public"."pf_external_participant"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE TRIGGER pf_external_participant_updated_at_trigger
BEFORE UPDATE ON "pf_external_participant"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
