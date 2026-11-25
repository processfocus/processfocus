ALTER TABLE "pf_flow" ADD COLUMN "interrupting" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pf_task_deadline" ADD COLUMN "interrupting" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pf_to_do" ADD COLUMN "interrupted_at" timestamp without time zone;