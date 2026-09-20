ALTER TABLE "pf_scheduled_flow" ADD COLUMN "completed_by_role" varchar(41);--> statement-breakpoint
ALTER TABLE "pf_scheduled_flow" ADD CONSTRAINT "pf_scheduled_flow_completed_by_role_pf_role_id_fk" FOREIGN KEY ("completed_by_role") REFERENCES "public"."pf_role"("id") ON DELETE no action ON UPDATE no action;
