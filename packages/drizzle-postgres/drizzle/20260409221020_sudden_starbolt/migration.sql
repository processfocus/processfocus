CREATE TABLE "pf_calendar_period" (
	"id" varchar(41) PRIMARY KEY NOT NULL,
	"org_unit_id" varchar(41) NOT NULL,
	"period_kind" varchar(64) NOT NULL,
	"period_title" "citext" NOT NULL,
	"period_start" timestamp without time zone NOT NULL,
	"period_end" timestamp without time zone NOT NULL,
	"period_active" boolean NOT NULL,
	"period_schedule" jsonb,
	"created_at" timestamp without time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp without time zone DEFAULT now() NOT NULL,
	"created_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"updated_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"_deleted" boolean DEFAULT false NOT NULL,
	CONSTRAINT "period_title_length_check" CHECK (length("pf_calendar_period"."period_title") <= 256)
);
--> statement-breakpoint
CREATE TABLE "pf_completed_job" (
	"id" varchar(41) PRIMARY KEY NOT NULL,
	"queue" varchar(512) NOT NULL,
	"job_id" varchar(1024) NOT NULL,
	"created_at" timestamp without time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp without time zone DEFAULT now() NOT NULL,
	"created_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"updated_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"_deleted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pf_date_exception" (
	"id" varchar(41) PRIMARY KEY NOT NULL,
	"org_unit_id" varchar(41) NOT NULL,
	"exception_date" timestamp without time zone NOT NULL,
	"exception_slots" jsonb NOT NULL,
	"exception_note" "citext",
	"created_at" timestamp without time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp without time zone DEFAULT now() NOT NULL,
	"created_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"updated_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"_deleted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pf_document_store" (
	"id" varchar(41) PRIMARY KEY NOT NULL,
	"org_unit_id" varchar(41) NOT NULL,
	"name" "citext" NOT NULL,
	"path" varchar(2048) NOT NULL,
	"accepted_types" jsonb,
	"size_limit" integer,
	"created_at" timestamp without time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp without time zone DEFAULT now() NOT NULL,
	"created_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"updated_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"_deleted" boolean DEFAULT false NOT NULL,
	CONSTRAINT "name_length_check" CHECK (length("pf_document_store"."name") <= 1024)
);
--> statement-breakpoint
CREATE TABLE "pf_file" (
	"id" varchar(41) PRIMARY KEY NOT NULL,
	"document_store_id" varchar(41) NOT NULL,
	"file_size" integer,
	"media_kind" varchar(256),
	"upload_pending" boolean DEFAULT true NOT NULL,
	"created_at" timestamp without time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp without time zone DEFAULT now() NOT NULL,
	"created_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"updated_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"_deleted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pf_flow" (
	"id" varchar(41) PRIMARY KEY NOT NULL,
	"flow_key" varchar(128) NOT NULL,
	"source_step" varchar(41) NOT NULL,
	"target_step" varchar(41) NOT NULL,
	"condition" "citext",
	"schedule" "citext",
	"fallback_branch" boolean DEFAULT false NOT NULL,
	"error_branch" boolean DEFAULT false NOT NULL,
	"error_tags" jsonb,
	"created_at" timestamp without time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp without time zone DEFAULT now() NOT NULL,
	"created_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"updated_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"_deleted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pf_holiday_instance" (
	"id" varchar(41) PRIMARY KEY NOT NULL,
	"org_unit_id" varchar(41) NOT NULL,
	"holiday_title" "citext" NOT NULL,
	"holiday_rule" jsonb NOT NULL,
	"holiday_date" timestamp without time zone,
	"created_at" timestamp without time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp without time zone DEFAULT now() NOT NULL,
	"created_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"updated_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"_deleted" boolean DEFAULT false NOT NULL,
	CONSTRAINT "holiday_title_length_check" CHECK (length("pf_holiday_instance"."holiday_title") <= 256)
);
--> statement-breakpoint
CREATE TABLE "pf_invitation" (
	"id" varchar(41) PRIMARY KEY NOT NULL,
	"invitation_id" varchar(128) NOT NULL,
	"email" varchar(320) NOT NULL,
	"created_at" timestamp without time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp without time zone DEFAULT now() NOT NULL,
	"created_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"updated_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"_deleted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pf_invitation_role" (
	"id" varchar(41) PRIMARY KEY NOT NULL,
	"invitation_id" varchar(41) NOT NULL,
	"role_id" varchar(41) NOT NULL,
	"created_at" timestamp without time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp without time zone DEFAULT now() NOT NULL,
	"created_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"updated_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"_deleted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pf_job_queue" (
	"id" varchar(41) PRIMARY KEY NOT NULL,
	"queue" varchar(512) NOT NULL,
	"job_payload" jsonb NOT NULL,
	"job_attempts" integer DEFAULT 0 NOT NULL,
	"job_retry_limit" integer DEFAULT 5 NOT NULL,
	"available_at" timestamp without time zone DEFAULT NOW() NOT NULL,
	"locked_until" timestamp without time zone,
	"created_at" timestamp without time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp without time zone DEFAULT now() NOT NULL,
	"created_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"updated_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"_deleted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pf_oauth_client" (
	"id" varchar(41) PRIMARY KEY NOT NULL,
	"client_id" varchar(128) NOT NULL,
	"client_secret_hash" varchar(256) NOT NULL,
	"audience" varchar(128) NOT NULL,
	"created_at" timestamp without time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp without time zone DEFAULT now() NOT NULL,
	"created_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"updated_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"_deleted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pf_oauth_provider" (
	"id" varchar(41) PRIMARY KEY NOT NULL,
	"provider_name" varchar(64) NOT NULL,
	"provider_config" jsonb NOT NULL,
	"created_at" timestamp without time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp without time zone DEFAULT now() NOT NULL,
	"created_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"updated_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"_deleted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pf_oauth_storage" (
	"id" varchar(41) PRIMARY KEY NOT NULL,
	"oauth_key" varchar(2048) NOT NULL,
	"key_kind" varchar(64) NOT NULL,
	"key_value" jsonb NOT NULL,
	"key_expiry" timestamp without time zone,
	"created_at" timestamp without time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp without time zone DEFAULT now() NOT NULL,
	"created_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"updated_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"_deleted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pf_org_unit" (
	"id" varchar(41) PRIMARY KEY NOT NULL,
	"name" "citext" NOT NULL,
	"org_unit_level" varchar(64) NOT NULL,
	"parent_org_unit" varchar(41),
	"path" varchar(2048) NOT NULL,
	"acronym" "citext",
	"timezone" varchar(64) DEFAULT 'UTC' NOT NULL,
	"start_day_of_week" integer DEFAULT 0,
	"created_at" timestamp without time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp without time zone DEFAULT now() NOT NULL,
	"created_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"updated_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"_deleted" boolean DEFAULT false NOT NULL,
	CONSTRAINT "name_length_check" CHECK (length("pf_org_unit"."name") <= 1024),
	CONSTRAINT "acronym_length_check" CHECK (length("pf_org_unit"."acronym") <= 64)
);
--> statement-breakpoint
CREATE TABLE "pf_permitted_client_email" (
	"id" varchar(41) PRIMARY KEY NOT NULL,
	"oauth_client_id" varchar(41) NOT NULL,
	"email" varchar(320) NOT NULL,
	"created_at" timestamp without time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp without time zone DEFAULT now() NOT NULL,
	"created_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"updated_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"_deleted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pf_permitted_client_role" (
	"id" varchar(41) PRIMARY KEY NOT NULL,
	"oauth_client_id" varchar(41) NOT NULL,
	"role_id" varchar(41) NOT NULL,
	"created_at" timestamp without time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp without time zone DEFAULT now() NOT NULL,
	"created_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"updated_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"_deleted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pf_permitted_role" (
	"id" varchar(41) PRIMARY KEY NOT NULL,
	"provider_user_id" varchar(41) NOT NULL,
	"role_id" varchar(41) NOT NULL,
	"created_at" timestamp without time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp without time zone DEFAULT now() NOT NULL,
	"created_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"updated_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"_deleted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pf_phase" (
	"id" varchar(41) PRIMARY KEY NOT NULL,
	"process_id" varchar(41) NOT NULL,
	"name" "citext" NOT NULL,
	"path" varchar(2048) NOT NULL,
	"phase_order" integer NOT NULL,
	"created_at" timestamp without time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp without time zone DEFAULT now() NOT NULL,
	"created_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"updated_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"_deleted" boolean DEFAULT false NOT NULL,
	CONSTRAINT "name_length_check" CHECK (length("pf_phase"."name") <= 1024)
);
--> statement-breakpoint
CREATE TABLE "pf_process" (
	"id" varchar(41) PRIMARY KEY NOT NULL,
	"org_unit_id" varchar(41) NOT NULL,
	"name" "citext" NOT NULL,
	"path" varchar(2048) NOT NULL,
	"purpose" "citext" NOT NULL,
	"sla_value" integer,
	"sla_unit" varchar(16),
	"sla_warning" integer,
	"created_at" timestamp without time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp without time zone DEFAULT now() NOT NULL,
	"created_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"updated_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"_deleted" boolean DEFAULT false NOT NULL,
	CONSTRAINT "name_length_check" CHECK (length("pf_process"."name") <= 1024)
);
--> statement-breakpoint
CREATE TABLE "pf_process_execution" (
	"id" varchar(41) PRIMARY KEY NOT NULL,
	"process_state_id" varchar(41) NOT NULL,
	"finished_at" timestamp without time zone,
	"business_duration" integer,
	"abandoned_at" timestamp without time zone,
	"abandoned_reason" "citext",
	"created_at" timestamp without time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp without time zone DEFAULT now() NOT NULL,
	"created_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"updated_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"_deleted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pf_process_state" (
	"id" varchar(41) PRIMARY KEY NOT NULL,
	"process_id" varchar(41) NOT NULL,
	"start_step" varchar(41) NOT NULL,
	"state" jsonb NOT NULL,
	"started_by_user" varchar(41),
	"created_at" timestamp without time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp without time zone DEFAULT now() NOT NULL,
	"created_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"updated_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"_deleted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pf_provider_user" (
	"id" varchar(41) PRIMARY KEY NOT NULL,
	"user_id" varchar(41) NOT NULL,
	"email" varchar(320) NOT NULL,
	"name" "citext" NOT NULL,
	"first_name" "citext" NOT NULL,
	"last_name" "citext" NOT NULL,
	"picture" varchar(1024) NOT NULL,
	"locale" varchar(35) NOT NULL,
	"org_unit_id" varchar(41) NOT NULL,
	"created_at" timestamp without time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp without time zone DEFAULT now() NOT NULL,
	"created_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"updated_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"_deleted" boolean DEFAULT false NOT NULL,
	CONSTRAINT "name_length_check" CHECK (length("pf_provider_user"."name") <= 1024),
	CONSTRAINT "first_name_length_check" CHECK (length("pf_provider_user"."first_name") <= 128),
	CONSTRAINT "last_name_length_check" CHECK (length("pf_provider_user"."last_name") <= 128)
);
--> statement-breakpoint
CREATE TABLE "pf_provider_user_role" (
	"id" varchar(41) PRIMARY KEY NOT NULL,
	"provider_user_id" varchar(41) NOT NULL,
	"role_id" varchar(41) NOT NULL,
	"created_at" timestamp without time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp without time zone DEFAULT now() NOT NULL,
	"created_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"updated_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"_deleted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pf_role" (
	"id" varchar(41) PRIMARY KEY NOT NULL,
	"org_unit_id" varchar(41) NOT NULL,
	"name" "citext" NOT NULL,
	"path" varchar(2048) NOT NULL,
	"created_at" timestamp without time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp without time zone DEFAULT now() NOT NULL,
	"created_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"updated_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"_deleted" boolean DEFAULT false NOT NULL,
	CONSTRAINT "name_length_check" CHECK (length("pf_role"."name") <= 1024)
);
--> statement-breakpoint
CREATE TABLE "pf_role_responsibility" (
	"id" varchar(41) PRIMARY KEY NOT NULL,
	"process_id" varchar(41) NOT NULL,
	"role_id" varchar(41) NOT NULL,
	"responsibility" "citext" NOT NULL,
	"responsibility_order" integer NOT NULL,
	"created_at" timestamp without time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp without time zone DEFAULT now() NOT NULL,
	"created_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"updated_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"_deleted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pf_scheduled_flow" (
	"id" varchar(41) PRIMARY KEY NOT NULL,
	"process_execution_id" varchar(41) NOT NULL,
	"source_step" varchar(41) NOT NULL,
	"target_step" varchar(41),
	"scheduled_at" timestamp without time zone,
	"for_each_barrier" boolean DEFAULT false NOT NULL,
	"created_at" timestamp without time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp without time zone DEFAULT now() NOT NULL,
	"created_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"updated_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"_deleted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pf_step" (
	"id" varchar(41) PRIMARY KEY NOT NULL,
	"name" "citext" NOT NULL,
	"path" varchar(2048) NOT NULL,
	"purpose" "citext" NOT NULL,
	"process_id" varchar(41) NOT NULL,
	"role_id" varchar(41),
	"form_fields" integer,
	"phase_id" varchar(41),
	"sla_value" integer,
	"sla_unit" varchar(16),
	"sla_warning" integer,
	"has_for_each" boolean DEFAULT false NOT NULL,
	"embedded" boolean DEFAULT false NOT NULL,
	"retry_limit" integer,
	"created_at" timestamp without time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp without time zone DEFAULT now() NOT NULL,
	"created_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"updated_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"_deleted" boolean DEFAULT false NOT NULL,
	CONSTRAINT "name_length_check" CHECK (length("pf_step"."name") <= 1024)
);
--> statement-breakpoint
CREATE TABLE "pf_step_document_store" (
	"id" varchar(41) PRIMARY KEY NOT NULL,
	"step_id" varchar(41) NOT NULL,
	"document_store_id" varchar(41) NOT NULL,
	"created_at" timestamp without time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp without time zone DEFAULT now() NOT NULL,
	"created_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"updated_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"_deleted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pf_to_do" (
	"id" varchar(41) PRIMARY KEY NOT NULL,
	"process_execution_id" varchar(41) NOT NULL,
	"flow_id" varchar(41) NOT NULL,
	"completed_by_user" varchar(41),
	"assigned_to_provider_user" varchar(41),
	"business_duration" integer,
	"sla_target_at" timestamp without time zone,
	"sla_warning_at" timestamp without time zone,
	"failure_reason" "citext",
	"item_data" jsonb,
	"barrier_scheduled_flow_id" varchar(41),
	"created_at" timestamp without time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp without time zone DEFAULT now() NOT NULL,
	"created_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"updated_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"_deleted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pf_user" (
	"id" varchar(41) PRIMARY KEY NOT NULL,
	"provider" varchar(128) NOT NULL,
	"sub" varchar(256) NOT NULL,
	"last_logged_in" timestamp without time zone NOT NULL,
	"created_at" timestamp without time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp without time zone DEFAULT now() NOT NULL,
	"created_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"updated_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"_deleted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pf_user_settings" (
	"id" varchar(41) PRIMARY KEY NOT NULL,
	"user_id" varchar(41) NOT NULL,
	"notification_preference" jsonb NOT NULL,
	"created_at" timestamp without time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp without time zone DEFAULT now() NOT NULL,
	"created_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"updated_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"_deleted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pf_weekly_schedule" (
	"id" varchar(41) PRIMARY KEY NOT NULL,
	"org_unit_id" varchar(41) NOT NULL,
	"day_of_week" integer NOT NULL,
	"time_ranges" jsonb NOT NULL,
	"created_at" timestamp without time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp without time zone DEFAULT now() NOT NULL,
	"created_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"updated_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"_deleted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pf_calendar_period" ADD CONSTRAINT "pf_calendar_period_org_unit_id_pf_org_unit_id_fk" FOREIGN KEY ("org_unit_id") REFERENCES "public"."pf_org_unit"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pf_date_exception" ADD CONSTRAINT "pf_date_exception_org_unit_id_pf_org_unit_id_fk" FOREIGN KEY ("org_unit_id") REFERENCES "public"."pf_org_unit"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pf_document_store" ADD CONSTRAINT "pf_document_store_org_unit_id_pf_org_unit_id_fk" FOREIGN KEY ("org_unit_id") REFERENCES "public"."pf_org_unit"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pf_file" ADD CONSTRAINT "pf_file_document_store_id_pf_document_store_id_fk" FOREIGN KEY ("document_store_id") REFERENCES "public"."pf_document_store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pf_flow" ADD CONSTRAINT "pf_flow_source_step_pf_step_id_fk" FOREIGN KEY ("source_step") REFERENCES "public"."pf_step"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pf_flow" ADD CONSTRAINT "pf_flow_target_step_pf_step_id_fk" FOREIGN KEY ("target_step") REFERENCES "public"."pf_step"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pf_holiday_instance" ADD CONSTRAINT "pf_holiday_instance_org_unit_id_pf_org_unit_id_fk" FOREIGN KEY ("org_unit_id") REFERENCES "public"."pf_org_unit"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pf_invitation_role" ADD CONSTRAINT "pf_invitation_role_invitation_id_pf_invitation_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."pf_invitation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pf_invitation_role" ADD CONSTRAINT "pf_invitation_role_role_id_pf_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."pf_role"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pf_org_unit" ADD CONSTRAINT "pf_org_unit_parent_org_unit_pf_org_unit_id_fk" FOREIGN KEY ("parent_org_unit") REFERENCES "public"."pf_org_unit"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pf_permitted_client_email" ADD CONSTRAINT "pf_permitted_client_email_oauth_client_id_pf_oauth_client_id_fk" FOREIGN KEY ("oauth_client_id") REFERENCES "public"."pf_oauth_client"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pf_permitted_client_role" ADD CONSTRAINT "pf_permitted_client_role_oauth_client_id_pf_oauth_client_id_fk" FOREIGN KEY ("oauth_client_id") REFERENCES "public"."pf_oauth_client"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pf_permitted_client_role" ADD CONSTRAINT "pf_permitted_client_role_role_id_pf_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."pf_role"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pf_permitted_role" ADD CONSTRAINT "pf_permitted_role_provider_user_id_pf_provider_user_id_fk" FOREIGN KEY ("provider_user_id") REFERENCES "public"."pf_provider_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pf_permitted_role" ADD CONSTRAINT "pf_permitted_role_role_id_pf_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."pf_role"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pf_phase" ADD CONSTRAINT "pf_phase_process_id_pf_process_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."pf_process"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pf_process" ADD CONSTRAINT "pf_process_org_unit_id_pf_org_unit_id_fk" FOREIGN KEY ("org_unit_id") REFERENCES "public"."pf_org_unit"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pf_process_execution" ADD CONSTRAINT "pf_process_execution_process_state_id_pf_process_state_id_fk" FOREIGN KEY ("process_state_id") REFERENCES "public"."pf_process_state"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pf_process_state" ADD CONSTRAINT "pf_process_state_process_id_pf_process_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."pf_process"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pf_process_state" ADD CONSTRAINT "pf_process_state_start_step_pf_step_id_fk" FOREIGN KEY ("start_step") REFERENCES "public"."pf_step"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pf_process_state" ADD CONSTRAINT "pf_process_state_started_by_user_pf_user_id_fk" FOREIGN KEY ("started_by_user") REFERENCES "public"."pf_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pf_provider_user" ADD CONSTRAINT "pf_provider_user_user_id_pf_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."pf_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pf_provider_user" ADD CONSTRAINT "pf_provider_user_org_unit_id_pf_org_unit_id_fk" FOREIGN KEY ("org_unit_id") REFERENCES "public"."pf_org_unit"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pf_provider_user_role" ADD CONSTRAINT "pf_provider_user_role_provider_user_id_pf_provider_user_id_fk" FOREIGN KEY ("provider_user_id") REFERENCES "public"."pf_provider_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pf_provider_user_role" ADD CONSTRAINT "pf_provider_user_role_role_id_pf_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."pf_role"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pf_role" ADD CONSTRAINT "pf_role_org_unit_id_pf_org_unit_id_fk" FOREIGN KEY ("org_unit_id") REFERENCES "public"."pf_org_unit"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pf_role_responsibility" ADD CONSTRAINT "pf_role_responsibility_process_id_pf_process_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."pf_process"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pf_role_responsibility" ADD CONSTRAINT "pf_role_responsibility_role_id_pf_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."pf_role"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pf_scheduled_flow" ADD CONSTRAINT "pf_scheduled_flow_process_execution_id_pf_process_execution_id_fk" FOREIGN KEY ("process_execution_id") REFERENCES "public"."pf_process_execution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pf_scheduled_flow" ADD CONSTRAINT "pf_scheduled_flow_source_step_pf_step_id_fk" FOREIGN KEY ("source_step") REFERENCES "public"."pf_step"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pf_scheduled_flow" ADD CONSTRAINT "pf_scheduled_flow_target_step_pf_step_id_fk" FOREIGN KEY ("target_step") REFERENCES "public"."pf_step"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pf_step" ADD CONSTRAINT "pf_step_process_id_pf_process_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."pf_process"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pf_step" ADD CONSTRAINT "pf_step_role_id_pf_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."pf_role"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pf_step" ADD CONSTRAINT "pf_step_phase_id_pf_phase_id_fk" FOREIGN KEY ("phase_id") REFERENCES "public"."pf_phase"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pf_step_document_store" ADD CONSTRAINT "pf_step_document_store_step_id_pf_step_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."pf_step"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pf_step_document_store" ADD CONSTRAINT "pf_step_document_store_document_store_id_pf_document_store_id_fk" FOREIGN KEY ("document_store_id") REFERENCES "public"."pf_document_store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pf_to_do" ADD CONSTRAINT "pf_to_do_process_execution_id_pf_process_execution_id_fk" FOREIGN KEY ("process_execution_id") REFERENCES "public"."pf_process_execution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pf_to_do" ADD CONSTRAINT "pf_to_do_flow_id_pf_flow_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."pf_flow"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pf_to_do" ADD CONSTRAINT "pf_to_do_completed_by_user_pf_user_id_fk" FOREIGN KEY ("completed_by_user") REFERENCES "public"."pf_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pf_to_do" ADD CONSTRAINT "pf_to_do_assigned_to_provider_user_pf_provider_user_id_fk" FOREIGN KEY ("assigned_to_provider_user") REFERENCES "public"."pf_provider_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pf_user_settings" ADD CONSTRAINT "pf_user_settings_user_id_pf_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."pf_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pf_weekly_schedule" ADD CONSTRAINT "pf_weekly_schedule_org_unit_id_pf_org_unit_id_fk" FOREIGN KEY ("org_unit_id") REFERENCES "public"."pf_org_unit"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pf_calendar_period_kinddateidx_idx" ON "pf_calendar_period" USING btree ("period_kind","period_start","period_end") WHERE _deleted = false;--> statement-breakpoint
CREATE INDEX "pf_calendar_period_updated_at_id_idx" ON "pf_calendar_period" USING btree ("updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "pf_completed_job_job_id_ix_idx" ON "pf_completed_job" USING btree ("queue","job_id") WHERE _deleted = false;--> statement-breakpoint
CREATE INDEX "pf_completed_job_updated_at_id_idx" ON "pf_completed_job" USING btree ("updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "pf_date_exception_orgunitdateidx_idx" ON "pf_date_exception" USING btree ("org_unit_id","exception_date") WHERE _deleted = false;--> statement-breakpoint
CREATE INDEX "pf_date_exception_updated_at_id_idx" ON "pf_date_exception" USING btree ("updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "pf_document_store_pathidx_idx" ON "pf_document_store" USING btree ("path") WHERE _deleted = false;--> statement-breakpoint
CREATE INDEX "pf_document_store_updated_at_id_idx" ON "pf_document_store" USING btree ("updated_at","id");--> statement-breakpoint
CREATE INDEX "pf_file_updated_at_id_idx" ON "pf_file" USING btree ("updated_at","id");--> statement-breakpoint
CREATE INDEX "pf_flow_sourcetargetidx_idx" ON "pf_flow" USING btree ("source_step","target_step") WHERE _deleted = false;--> statement-breakpoint
CREATE UNIQUE INDEX "pf_flow_flowkeyidx_idx" ON "pf_flow" USING btree ("flow_key") WHERE _deleted = false;--> statement-breakpoint
CREATE INDEX "pf_flow_updated_at_id_idx" ON "pf_flow" USING btree ("updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "pf_holiday_instance_orgunittitleidx_idx" ON "pf_holiday_instance" USING btree ("org_unit_id","holiday_title") WHERE _deleted = false;--> statement-breakpoint
CREATE INDEX "pf_holiday_instance_updated_at_id_idx" ON "pf_holiday_instance" USING btree ("updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "pf_invitation_invitationididx_idx" ON "pf_invitation" USING btree ("invitation_id") WHERE _deleted = false;--> statement-breakpoint
CREATE UNIQUE INDEX "pf_invitation_emailidx_idx" ON "pf_invitation" USING btree ("email") WHERE _deleted = false;--> statement-breakpoint
CREATE INDEX "pf_invitation_updated_at_id_idx" ON "pf_invitation" USING btree ("updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "pf_invitation_role_invitationroleidx_idx" ON "pf_invitation_role" USING btree ("invitation_id","role_id") WHERE _deleted = false;--> statement-breakpoint
CREATE INDEX "pf_invitation_role_updated_at_id_idx" ON "pf_invitation_role" USING btree ("updated_at","id");--> statement-breakpoint
CREATE INDEX "pf_job_queue_ready_idx_idx" ON "pf_job_queue" USING btree ("queue","locked_until","job_attempts","available_at") WHERE _deleted = false;--> statement-breakpoint
CREATE INDEX "pf_job_queue_updated_at_id_idx" ON "pf_job_queue" USING btree ("updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "pf_oauth_client_clientididx_idx" ON "pf_oauth_client" USING btree ("client_id") WHERE _deleted = false;--> statement-breakpoint
CREATE INDEX "pf_oauth_client_updated_at_id_idx" ON "pf_oauth_client" USING btree ("updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "pf_oauth_provider_nameidx_idx" ON "pf_oauth_provider" USING btree ("provider_name") WHERE _deleted = false;--> statement-breakpoint
CREATE INDEX "pf_oauth_provider_updated_at_id_idx" ON "pf_oauth_provider" USING btree ("updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "pf_oauth_storage_keyidx_idx" ON "pf_oauth_storage" USING btree ("oauth_key");--> statement-breakpoint
CREATE INDEX "pf_oauth_storage_updated_at_id_idx" ON "pf_oauth_storage" USING btree ("updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "pf_org_unit_pathidx_idx" ON "pf_org_unit" USING btree ("path") WHERE _deleted = false;--> statement-breakpoint
CREATE INDEX "pf_org_unit_updated_at_id_idx" ON "pf_org_unit" USING btree ("updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "pf_permitted_client_email_oauthclientemailidx_idx" ON "pf_permitted_client_email" USING btree ("oauth_client_id","email") WHERE _deleted = false;--> statement-breakpoint
CREATE INDEX "pf_permitted_client_email_updated_at_id_idx" ON "pf_permitted_client_email" USING btree ("updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "pf_permitted_client_role_oauthclientroleidx_idx" ON "pf_permitted_client_role" USING btree ("oauth_client_id","role_id") WHERE _deleted = false;--> statement-breakpoint
CREATE INDEX "pf_permitted_client_role_updated_at_id_idx" ON "pf_permitted_client_role" USING btree ("updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "pf_permitted_role_provideruserroleidx_idx" ON "pf_permitted_role" USING btree ("provider_user_id","role_id") WHERE _deleted = false;--> statement-breakpoint
CREATE INDEX "pf_permitted_role_updated_at_id_idx" ON "pf_permitted_role" USING btree ("updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "pf_phase_pathidx_idx" ON "pf_phase" USING btree ("path") WHERE _deleted = false;--> statement-breakpoint
CREATE INDEX "pf_phase_updated_at_id_idx" ON "pf_phase" USING btree ("updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "pf_process_pathidx_idx" ON "pf_process" USING btree ("path") WHERE _deleted = false;--> statement-breakpoint
CREATE INDEX "pf_process_updated_at_id_idx" ON "pf_process" USING btree ("updated_at","id");--> statement-breakpoint
CREATE INDEX "pf_process_execution_updated_at_id_idx" ON "pf_process_execution" USING btree ("updated_at","id");--> statement-breakpoint
CREATE INDEX "pf_process_state_updated_at_id_idx" ON "pf_process_state" USING btree ("updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "pf_provider_user_emailidx_idx" ON "pf_provider_user" USING btree ("email") WHERE _deleted = false;--> statement-breakpoint
CREATE UNIQUE INDEX "pf_provider_user_user_unique_idx" ON "pf_provider_user" USING btree ("user_id") WHERE _deleted = false;--> statement-breakpoint
CREATE INDEX "pf_provider_user_updated_at_id_idx" ON "pf_provider_user" USING btree ("updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "pf_provider_user_role_provideruserroleidx_idx" ON "pf_provider_user_role" USING btree ("provider_user_id","role_id") WHERE _deleted = false;--> statement-breakpoint
CREATE INDEX "pf_provider_user_role_updated_at_id_idx" ON "pf_provider_user_role" USING btree ("updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "pf_role_pathidx_idx" ON "pf_role" USING btree ("path") WHERE _deleted = false;--> statement-breakpoint
CREATE UNIQUE INDEX "pf_role_orgunitunameidx_idx" ON "pf_role" USING btree ("org_unit_id","name") WHERE _deleted = false;--> statement-breakpoint
CREATE INDEX "pf_role_updated_at_id_idx" ON "pf_role" USING btree ("updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "pf_role_responsibility_processroleidx_idx" ON "pf_role_responsibility" USING btree ("process_id","role_id") WHERE _deleted = false;--> statement-breakpoint
CREATE INDEX "pf_role_responsibility_updated_at_id_idx" ON "pf_role_responsibility" USING btree ("updated_at","id");--> statement-breakpoint
CREATE INDEX "pf_scheduled_flow_updated_at_id_idx" ON "pf_scheduled_flow" USING btree ("updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "pf_step_pathidx_idx" ON "pf_step" USING btree ("path") WHERE _deleted = false;--> statement-breakpoint
CREATE INDEX "pf_step_updated_at_id_idx" ON "pf_step" USING btree ("updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "pf_step_document_store_stepdocstoreidx_idx" ON "pf_step_document_store" USING btree ("step_id","document_store_id") WHERE _deleted = false;--> statement-breakpoint
CREATE INDEX "pf_step_document_store_updated_at_id_idx" ON "pf_step_document_store" USING btree ("updated_at","id");--> statement-breakpoint
CREATE INDEX "pf_to_do_updated_at_id_idx" ON "pf_to_do" USING btree ("updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "pf_user_uniquesub_idx" ON "pf_user" USING btree ("provider","sub") WHERE _deleted = false;--> statement-breakpoint
CREATE INDEX "pf_user_updated_at_id_idx" ON "pf_user" USING btree ("updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "pf_user_settings_user_unique_idx" ON "pf_user_settings" USING btree ("user_id") WHERE _deleted = false;--> statement-breakpoint
CREATE INDEX "pf_user_settings_updated_at_id_idx" ON "pf_user_settings" USING btree ("updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "pf_weekly_schedule_orgunitdayidx_idx" ON "pf_weekly_schedule" USING btree ("org_unit_id","day_of_week") WHERE _deleted = false;--> statement-breakpoint
CREATE INDEX "pf_weekly_schedule_updated_at_id_idx" ON "pf_weekly_schedule" USING btree ("updated_at","id");--> statement-breakpoint
CREATE VIEW "public"."pf_process_its_active_processes" AS (
  select
    pf_process.id,
    count(distinct pf_to_do.id) as active_processes
  from pf_process
  left outer join pf_process_state on pf_process_state.process_id = pf_process.id and pf_process_state._deleted = false
  left outer join pf_process_execution on pf_process_execution.process_state_id = pf_process_state.id and pf_process_execution._deleted = false
  left outer join pf_to_do on pf_to_do.process_execution_id = pf_process_execution.id and pf_to_do._deleted = false
  group by
    pf_process.id
);--> statement-breakpoint
CREATE VIEW "public"."pf_process_its_no_drafts" AS (
  select
    id,
    not exists (select 1 from pf_process_execution
    join pf_process_state on pf_process_execution.process_state_id = pf_process_state.id and pf_process_state._deleted = false
    where pf_process_state.process_id = pf_process.id and pf_process_execution._deleted = false) as no_drafts
  from pf_process
);--> statement-breakpoint
CREATE VIEW "public"."pf_process_state_its_is_draft" AS (
  select
    id,
    not exists (select 1 from pf_process_execution where pf_process_execution.process_state_id = pf_process_state.id and pf_process_execution._deleted = false) as is_draft
  from pf_process_state
);--> statement-breakpoint
CREATE VIEW "public"."pf_step_its_can_start_process" AS (
  select
    id,
    not exists (select 1 from pf_flow where pf_flow.target_step = pf_step.id and pf_flow._deleted = false) as can_start_process
  from pf_step
);--> statement-breakpoint
CREATE VIEW "public"."pf_process_its_start_step" AS (
  select
    id,
    (select pf_step.id from pf_step
    join pf_step_its_can_start_process on pf_step.id = pf_step_its_can_start_process.id
    where pf_step.process_id = pf_process.id
    and pf_step_its_can_start_process.can_start_process = true
    and pf_step._deleted = false
    limit 1) as start_step
  from pf_process
);
