CREATE TABLE "pf_step_supporting_role" (
	"id" varchar(41) PRIMARY KEY NOT NULL,
	"step_id" varchar(41) NOT NULL,
	"role_id" varchar(41) NOT NULL,
	"created_at" timestamp without time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp without time zone DEFAULT now() NOT NULL,
	"created_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"updated_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"_deleted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pf_to_do" ADD COLUMN "completed_by_role" varchar(41);--> statement-breakpoint
ALTER TABLE "pf_step_supporting_role" ADD CONSTRAINT "pf_step_supporting_role_step_id_pf_step_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."pf_step"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pf_step_supporting_role" ADD CONSTRAINT "pf_step_supporting_role_role_id_pf_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."pf_role"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pf_step_supporting_role_steproleidx_idx" ON "pf_step_supporting_role" USING btree ("step_id","role_id") WHERE _deleted = false;--> statement-breakpoint
CREATE INDEX "pf_step_supporting_role_updated_at_id_idx" ON "pf_step_supporting_role" USING btree ("updated_at","id");--> statement-breakpoint
ALTER TABLE "pf_to_do" ADD CONSTRAINT "pf_to_do_completed_by_role_pf_role_id_fk" FOREIGN KEY ("completed_by_role") REFERENCES "public"."pf_role"("id") ON DELETE no action ON UPDATE no action;
