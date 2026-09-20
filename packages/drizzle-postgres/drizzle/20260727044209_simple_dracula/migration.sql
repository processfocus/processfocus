CREATE TABLE "pf_passkey_credential" (
	"id" varchar(41) PRIMARY KEY,
	"user_id" varchar(41) NOT NULL,
	"passkey_credential_id" varchar(2048) NOT NULL,
	"passkey_public_key" varchar(2048) NOT NULL,
	"signature_counter" integer NOT NULL,
	"passkey_transports" jsonb,
	"created_at" timestamp without time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp without time zone DEFAULT now() NOT NULL,
	"created_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"updated_by" varchar(256) DEFAULT 'SYSTEM' NOT NULL,
	"_deleted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "pf_passkey_credential_credentialidx_idx" ON "pf_passkey_credential" ("passkey_credential_id") WHERE _deleted = false;--> statement-breakpoint
CREATE INDEX "pf_passkey_credential_updated_at_id_idx" ON "pf_passkey_credential" ("updated_at","id");--> statement-breakpoint
ALTER TABLE "pf_passkey_credential" ADD CONSTRAINT "pf_passkey_credential_user_id_pf_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "pf_user"("id");
--> statement-breakpoint
DELETE FROM "pf_oauth_storage" WHERE "key_kind" = 'passkey';
--> statement-breakpoint
UPDATE "pf_provider_user_role"
SET "_deleted" = true, "updated_at" = now(), "updated_by" = 'SYSTEM'
WHERE "_deleted" = false AND "provider_user_id" IN (
	SELECT "pu"."id" FROM "pf_provider_user" "pu"
	INNER JOIN "pf_user" "u" ON "u"."id" = "pu"."user_id"
	WHERE "u"."provider" = 'passkey' AND "u"."_deleted" = false
);
--> statement-breakpoint
UPDATE "pf_permitted_role"
SET "_deleted" = true, "updated_at" = now(), "updated_by" = 'SYSTEM'
WHERE "_deleted" = false AND "provider_user_id" IN (
	SELECT "pu"."id" FROM "pf_provider_user" "pu"
	INNER JOIN "pf_user" "u" ON "u"."id" = "pu"."user_id"
	WHERE "u"."provider" = 'passkey' AND "u"."_deleted" = false
);
--> statement-breakpoint
UPDATE "pf_user_settings"
SET "_deleted" = true, "updated_at" = now(), "updated_by" = 'SYSTEM'
WHERE "_deleted" = false AND "user_id" IN (
	SELECT "id" FROM "pf_user" WHERE "provider" = 'passkey' AND "_deleted" = false
);
--> statement-breakpoint
UPDATE "pf_provider_user"
SET "_deleted" = true, "updated_at" = now(), "updated_by" = 'SYSTEM'
WHERE "_deleted" = false AND "user_id" IN (
	SELECT "id" FROM "pf_user" WHERE "provider" = 'passkey' AND "_deleted" = false
);
--> statement-breakpoint
UPDATE "pf_user"
SET "_deleted" = true, "updated_at" = now(), "updated_by" = 'SYSTEM'
WHERE "_deleted" = false AND "provider" = 'passkey';
