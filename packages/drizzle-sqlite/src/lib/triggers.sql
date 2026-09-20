-- Generated from Xplain DDL: schema.ddl
-- Auto-generated triggers for updated_at columns
-- DO NOT EDIT

CREATE TRIGGER IF NOT EXISTS pf_org_unit_updated_at_trigger
AFTER UPDATE ON "pf_org_unit"
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE "pf_org_unit" SET updated_at = julianday('now') WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS pf_process_updated_at_trigger
AFTER UPDATE ON "pf_process"
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE "pf_process" SET updated_at = julianday('now') WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS pf_role_updated_at_trigger
AFTER UPDATE ON "pf_role"
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE "pf_role" SET updated_at = julianday('now') WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS pf_phase_updated_at_trigger
AFTER UPDATE ON "pf_phase"
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE "pf_phase" SET updated_at = julianday('now') WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS pf_role_responsibility_updated_at_trigger
AFTER UPDATE ON "pf_role_responsibility"
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE "pf_role_responsibility" SET updated_at = julianday('now') WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS pf_step_updated_at_trigger
AFTER UPDATE ON "pf_step"
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE "pf_step" SET updated_at = julianday('now') WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS pf_step_supporting_role_updated_at_trigger
AFTER UPDATE ON "pf_step_supporting_role"
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE "pf_step_supporting_role" SET updated_at = julianday('now') WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS pf_flow_updated_at_trigger
AFTER UPDATE ON "pf_flow"
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE "pf_flow" SET updated_at = julianday('now') WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS pf_external_participant_updated_at_trigger
AFTER UPDATE ON "pf_external_participant"
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE "pf_external_participant" SET updated_at = julianday('now') WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS pf_process_state_updated_at_trigger
AFTER UPDATE ON "pf_process_state"
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE "pf_process_state" SET updated_at = julianday('now') WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS pf_process_execution_updated_at_trigger
AFTER UPDATE ON "pf_process_execution"
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE "pf_process_execution" SET updated_at = julianday('now') WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS pf_to_do_updated_at_trigger
AFTER UPDATE ON "pf_to_do"
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE "pf_to_do" SET updated_at = julianday('now') WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS pf_public_completion_invitation_attempt_updated_at_trigger
AFTER UPDATE ON "pf_public_completion_invitation_attempt"
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE "pf_public_completion_invitation_attempt" SET updated_at = julianday('now') WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS pf_scheduled_flow_updated_at_trigger
AFTER UPDATE ON "pf_scheduled_flow"
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE "pf_scheduled_flow" SET updated_at = julianday('now') WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS pf_user_updated_at_trigger
AFTER UPDATE ON "pf_user"
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE "pf_user" SET updated_at = julianday('now') WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS pf_passkey_credential_updated_at_trigger
AFTER UPDATE ON "pf_passkey_credential"
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE "pf_passkey_credential" SET updated_at = julianday('now') WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS pf_provider_user_updated_at_trigger
AFTER UPDATE ON "pf_provider_user"
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE "pf_provider_user" SET updated_at = julianday('now') WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS pf_delegation_updated_at_trigger
AFTER UPDATE ON "pf_delegation"
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE "pf_delegation" SET updated_at = julianday('now') WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS pf_secret_generation_updated_at_trigger
AFTER UPDATE ON "pf_secret_generation"
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE "pf_secret_generation" SET updated_at = julianday('now') WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS pf_delegation_history_updated_at_trigger
AFTER UPDATE ON "pf_delegation_history"
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE "pf_delegation_history" SET updated_at = julianday('now') WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS pf_provider_user_role_updated_at_trigger
AFTER UPDATE ON "pf_provider_user_role"
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE "pf_provider_user_role" SET updated_at = julianday('now') WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS pf_user_settings_updated_at_trigger
AFTER UPDATE ON "pf_user_settings"
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE "pf_user_settings" SET updated_at = julianday('now') WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS pf_permitted_role_updated_at_trigger
AFTER UPDATE ON "pf_permitted_role"
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE "pf_permitted_role" SET updated_at = julianday('now') WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS pf_permitted_client_role_updated_at_trigger
AFTER UPDATE ON "pf_permitted_client_role"
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE "pf_permitted_client_role" SET updated_at = julianday('now') WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS pf_permitted_client_email_updated_at_trigger
AFTER UPDATE ON "pf_permitted_client_email"
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE "pf_permitted_client_email" SET updated_at = julianday('now') WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS pf_invitation_updated_at_trigger
AFTER UPDATE ON "pf_invitation"
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE "pf_invitation" SET updated_at = julianday('now') WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS pf_registration_session_updated_at_trigger
AFTER UPDATE ON "pf_registration_session"
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE "pf_registration_session" SET updated_at = julianday('now') WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS pf_invitation_role_updated_at_trigger
AFTER UPDATE ON "pf_invitation_role"
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE "pf_invitation_role" SET updated_at = julianday('now') WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS pf_oauth_storage_updated_at_trigger
AFTER UPDATE ON "pf_oauth_storage"
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE "pf_oauth_storage" SET updated_at = julianday('now') WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS pf_oauth_provider_updated_at_trigger
AFTER UPDATE ON "pf_oauth_provider"
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE "pf_oauth_provider" SET updated_at = julianday('now') WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS pf_oauth_client_updated_at_trigger
AFTER UPDATE ON "pf_oauth_client"
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE "pf_oauth_client" SET updated_at = julianday('now') WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS pf_job_queue_updated_at_trigger
AFTER UPDATE ON "pf_job_queue"
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE "pf_job_queue" SET updated_at = julianday('now') WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS pf_completed_job_updated_at_trigger
AFTER UPDATE ON "pf_completed_job"
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE "pf_completed_job" SET updated_at = julianday('now') WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS pf_weekly_schedule_updated_at_trigger
AFTER UPDATE ON "pf_weekly_schedule"
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE "pf_weekly_schedule" SET updated_at = julianday('now') WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS pf_calendar_period_updated_at_trigger
AFTER UPDATE ON "pf_calendar_period"
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE "pf_calendar_period" SET updated_at = julianday('now') WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS pf_date_exception_updated_at_trigger
AFTER UPDATE ON "pf_date_exception"
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE "pf_date_exception" SET updated_at = julianday('now') WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS pf_holiday_instance_updated_at_trigger
AFTER UPDATE ON "pf_holiday_instance"
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE "pf_holiday_instance" SET updated_at = julianday('now') WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS pf_document_store_updated_at_trigger
AFTER UPDATE ON "pf_document_store"
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE "pf_document_store" SET updated_at = julianday('now') WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS pf_file_updated_at_trigger
AFTER UPDATE ON "pf_file"
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE "pf_file" SET updated_at = julianday('now') WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS pf_step_document_store_updated_at_trigger
AFTER UPDATE ON "pf_step_document_store"
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE "pf_step_document_store" SET updated_at = julianday('now') WHERE id = NEW.id;
END;