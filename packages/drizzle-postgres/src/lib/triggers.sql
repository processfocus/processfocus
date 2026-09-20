-- Generated from Xplain DDL: schema.ddl
-- Auto-generated triggers for updated_at columns
-- DO NOT EDIT

-- Reusable function for updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.updated_at = OLD.updated_at THEN
    NEW.updated_at = NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
-- Triggers for all tables
CREATE TRIGGER pf_org_unit_updated_at_trigger
BEFORE UPDATE ON "pf_org_unit"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER pf_process_updated_at_trigger
BEFORE UPDATE ON "pf_process"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER pf_role_updated_at_trigger
BEFORE UPDATE ON "pf_role"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER pf_phase_updated_at_trigger
BEFORE UPDATE ON "pf_phase"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER pf_role_responsibility_updated_at_trigger
BEFORE UPDATE ON "pf_role_responsibility"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER pf_step_updated_at_trigger
BEFORE UPDATE ON "pf_step"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER pf_step_supporting_role_updated_at_trigger
BEFORE UPDATE ON "pf_step_supporting_role"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER pf_flow_updated_at_trigger
BEFORE UPDATE ON "pf_flow"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER pf_external_participant_updated_at_trigger
BEFORE UPDATE ON "pf_external_participant"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER pf_process_state_updated_at_trigger
BEFORE UPDATE ON "pf_process_state"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER pf_process_execution_updated_at_trigger
BEFORE UPDATE ON "pf_process_execution"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER pf_to_do_updated_at_trigger
BEFORE UPDATE ON "pf_to_do"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER pf_public_completion_invitation_attempt_updated_at_trigger
BEFORE UPDATE ON "pf_public_completion_invitation_attempt"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER pf_scheduled_flow_updated_at_trigger
BEFORE UPDATE ON "pf_scheduled_flow"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER pf_user_updated_at_trigger
BEFORE UPDATE ON "pf_user"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER pf_passkey_credential_updated_at_trigger
BEFORE UPDATE ON "pf_passkey_credential"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER pf_provider_user_updated_at_trigger
BEFORE UPDATE ON "pf_provider_user"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER pf_delegation_updated_at_trigger
BEFORE UPDATE ON "pf_delegation"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER pf_secret_generation_updated_at_trigger
BEFORE UPDATE ON "pf_secret_generation"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER pf_delegation_history_updated_at_trigger
BEFORE UPDATE ON "pf_delegation_history"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER pf_provider_user_role_updated_at_trigger
BEFORE UPDATE ON "pf_provider_user_role"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER pf_user_settings_updated_at_trigger
BEFORE UPDATE ON "pf_user_settings"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER pf_permitted_role_updated_at_trigger
BEFORE UPDATE ON "pf_permitted_role"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER pf_permitted_client_role_updated_at_trigger
BEFORE UPDATE ON "pf_permitted_client_role"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER pf_permitted_client_email_updated_at_trigger
BEFORE UPDATE ON "pf_permitted_client_email"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER pf_invitation_updated_at_trigger
BEFORE UPDATE ON "pf_invitation"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER pf_registration_session_updated_at_trigger
BEFORE UPDATE ON "pf_registration_session"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER pf_invitation_role_updated_at_trigger
BEFORE UPDATE ON "pf_invitation_role"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER pf_oauth_storage_updated_at_trigger
BEFORE UPDATE ON "pf_oauth_storage"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER pf_oauth_provider_updated_at_trigger
BEFORE UPDATE ON "pf_oauth_provider"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER pf_oauth_client_updated_at_trigger
BEFORE UPDATE ON "pf_oauth_client"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER pf_job_queue_updated_at_trigger
BEFORE UPDATE ON "pf_job_queue"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER pf_completed_job_updated_at_trigger
BEFORE UPDATE ON "pf_completed_job"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER pf_weekly_schedule_updated_at_trigger
BEFORE UPDATE ON "pf_weekly_schedule"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER pf_calendar_period_updated_at_trigger
BEFORE UPDATE ON "pf_calendar_period"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER pf_date_exception_updated_at_trigger
BEFORE UPDATE ON "pf_date_exception"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER pf_holiday_instance_updated_at_trigger
BEFORE UPDATE ON "pf_holiday_instance"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER pf_document_store_updated_at_trigger
BEFORE UPDATE ON "pf_document_store"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER pf_file_updated_at_trigger
BEFORE UPDATE ON "pf_file"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER pf_step_document_store_updated_at_trigger
BEFORE UPDATE ON "pf_step_document_store"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();