CREATE INDEX `pf_flow_targetidx_idx` ON `pf_flow` (`target_step`) WHERE _deleted = 0;--> statement-breakpoint
CREATE INDEX `pf_process_state_processidx_idx` ON `pf_process_state` (`process_id`) WHERE _deleted = 0;--> statement-breakpoint
CREATE INDEX `pf_step_processidx_idx` ON `pf_step` (`process_id`) WHERE _deleted = 0;--> statement-breakpoint
CREATE INDEX `pf_to_do_executionidx_idx` ON `pf_to_do` (`process_execution_id`) WHERE _deleted = 0;