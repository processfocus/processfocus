ALTER TABLE `pf_flow` ADD `interrupting` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `pf_task_deadline` ADD `interrupting` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `pf_to_do` ADD `interrupted_at` real;