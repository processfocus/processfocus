ALTER TABLE "pf_passkey_credential" ALTER COLUMN "signature_counter" SET DATA TYPE varchar(16) USING "signature_counter"::varchar(16);
--> statement-breakpoint
CREATE TRIGGER pf_passkey_credential_updated_at_trigger
BEFORE UPDATE ON "pf_passkey_credential"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
