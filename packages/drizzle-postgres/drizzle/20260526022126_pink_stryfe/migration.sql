ALTER TABLE "pf_process_state" ADD COLUMN "started_by_role" varchar(41);--> statement-breakpoint
ALTER TABLE "pf_process_state" ADD CONSTRAINT "pf_process_state_started_by_role_pf_role_id_fk" FOREIGN KEY ("started_by_role") REFERENCES "public"."pf_role"("id") ON DELETE no action ON UPDATE no action;
