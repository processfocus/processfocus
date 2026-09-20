ALTER TABLE "pf_invitation" ADD COLUMN "registration_token_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "pf_invitation" ADD COLUMN "registration_encryption_version" integer;--> statement-breakpoint
ALTER TABLE "pf_invitation" ADD COLUMN "registration_encryption_nonce" varchar(24);--> statement-breakpoint
ALTER TABLE "pf_invitation" ADD COLUMN "registration_authentication_tag" varchar(32);--> statement-breakpoint
ALTER TABLE "pf_invitation" ADD COLUMN "registration_encrypted_token" citext;--> statement-breakpoint
ALTER TABLE "pf_invitation" ADD COLUMN "registration_link_expires_at" timestamp without time zone;--> statement-breakpoint
ALTER TABLE "pf_invitation" ADD COLUMN "registration_link_generated_at" timestamp without time zone;--> statement-breakpoint
ALTER TABLE "pf_invitation" ADD COLUMN "registration_link_generated_by" varchar(256);--> statement-breakpoint
ALTER TABLE "pf_invitation" ADD COLUMN "registration_link_revealed_at" timestamp without time zone;--> statement-breakpoint
ALTER TABLE "pf_invitation" ADD COLUMN "registration_link_revealed_by" varchar(256);--> statement-breakpoint
ALTER TABLE "pf_invitation" ADD COLUMN "registration_link_revoked_at" timestamp without time zone;--> statement-breakpoint
ALTER TABLE "pf_invitation" ADD COLUMN "registration_link_revoked_by" varchar(256);--> statement-breakpoint
ALTER TABLE "pf_invitation" ADD COLUMN "registration_link_generation" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "pf_invitation_registrationtokenhashidx_idx" ON "pf_invitation" ("registration_token_hash") WHERE _deleted = false;