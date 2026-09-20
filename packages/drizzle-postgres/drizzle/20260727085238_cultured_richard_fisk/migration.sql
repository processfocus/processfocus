ALTER TABLE "pf_invitation" ADD COLUMN "invitation_status" varchar(32) DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "pf_invitation" ADD COLUMN "invitation_source" varchar(32) DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "pf_invitation" ADD COLUMN "invitation_pending_email" varchar(320);--> statement-breakpoint
ALTER TABLE "pf_invitation" ADD COLUMN "invitation_accepted_at" timestamp without time zone;--> statement-breakpoint
ALTER TABLE "pf_invitation" ADD COLUMN "invitation_accepted_by_provider" varchar(64);--> statement-breakpoint
ALTER TABLE "pf_invitation" ADD COLUMN "invitation_accepted_by_subject" varchar(256);--> statement-breakpoint
ALTER TABLE "pf_invitation" ADD COLUMN "accepted_by_provider_user" varchar(41);--> statement-breakpoint
ALTER TABLE "pf_invitation" ADD COLUMN "invitation_legacy_closed_at" timestamp without time zone;--> statement-breakpoint
ALTER TABLE "pf_invitation" ADD COLUMN "invitation_legacy_closure_reason" varchar(128);--> statement-breakpoint
DROP INDEX "pf_invitation_emailidx_idx";--> statement-breakpoint
CREATE INDEX "pf_invitation_emailidx_idx" ON "pf_invitation" ("email") WHERE _deleted = false;--> statement-breakpoint
CREATE INDEX "pf_invitation_statusidx_idx" ON "pf_invitation" ("invitation_status") WHERE _deleted = false;--> statement-breakpoint
ALTER TABLE "pf_invitation" ADD CONSTRAINT "pf_invitation_70jaAQUOzSQP_fkey" FOREIGN KEY ("accepted_by_provider_user") REFERENCES "pf_provider_user"("id");--> statement-breakpoint
-- Normalize emails and seed pending uniqueness for live invitations.
UPDATE "pf_invitation"
SET
  "email" = lower(trim("email")),
  "invitation_pending_email" = lower(trim("email")),
  "invitation_status" = 'pending',
  "invitation_source" = 'legacy',
  "updated_at" = now(),
  "updated_by" = 'SYSTEM'
WHERE "_deleted" = false;--> statement-breakpoint
-- Mark invitations that already match a non-passkey Provider User as
-- legacy-closed without inventing historical acceptance or role assignment.
UPDATE "pf_invitation" AS inv
SET
  "invitation_status" = 'legacy_closed',
  "invitation_pending_email" = NULL,
  "accepted_by_provider_user" = matched.provider_user_id,
  "invitation_legacy_closed_at" = now(),
  "invitation_legacy_closure_reason" = 'existing_provider_user',
  "updated_at" = now(),
  "updated_by" = 'SYSTEM'
FROM (
  SELECT DISTINCT ON (lower(trim(pu.email)))
    lower(trim(pu.email)) AS email,
    pu.id AS provider_user_id
  FROM pf_provider_user pu
  INNER JOIN pf_user u ON u.id = pu.user_id
  WHERE pu._deleted = false
    AND u._deleted = false
    AND u.provider <> 'passkey'
  ORDER BY lower(trim(pu.email)), pu.created_at ASC, pu.id ASC
) AS matched
WHERE inv._deleted = false
  AND inv.email = matched.email;--> statement-breakpoint
-- Collapse historically case-variant duplicate pending emails so the pending
-- uniqueness index can be created. Keep the oldest row; soft-delete the rest.
UPDATE "pf_invitation"
SET
  "_deleted" = true,
  "invitation_pending_email" = NULL,
  "updated_at" = now(),
  "updated_by" = 'SYSTEM'
WHERE "id" IN (
  SELECT "id" FROM (
    SELECT
      "id",
      ROW_NUMBER() OVER (
        PARTITION BY "invitation_pending_email"
        ORDER BY "created_at" ASC, "id" ASC
      ) AS rn
    FROM "pf_invitation"
    WHERE "_deleted" = false
      AND "invitation_status" = 'pending'
      AND "invitation_pending_email" IS NOT NULL
  ) AS ranked
  WHERE rn > 1
);--> statement-breakpoint
CREATE UNIQUE INDEX "pf_invitation_pendingemailidx_idx" ON "pf_invitation" ("invitation_pending_email") WHERE _deleted = false;
