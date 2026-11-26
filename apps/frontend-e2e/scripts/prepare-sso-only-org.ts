import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// Run inside run-temp-org --copy: provision configuration, never sessions.
const org = process.env["PF_ORG"]
if (!org?.includes("pf-temp-org-"))
  throw new Error("Disposable organisation required")
const source = join(org, "src/org.ts")
const original = readFileSync(source, "utf8")
const passkey = / {4}passkey: \{\s*rpName: "Process Focus Demo",\s*\},/
if (!passkey.test(original))
  throw new Error("Demo Passkey configuration changed; cannot ensure SSO-only")
writeFileSync(source, original.replace(passkey, ""))
const env: NodeJS.ProcessEnv = {
  ...process.env,
  MY_EMAIL: "test@example.com",
  GOOGLE_CLIENT_ID: "controlled-client",
  GOOGLE_CLIENT_SECRET: "controlled-secret",
  SSO_ONLY_JOURNEY: "1",
  SSO_PROVIDER_PORT: "0",
  SQLITE_DATABASE_PATH: join(org, "db/pf.db"),
  NODE_ENV: "development",
}
delete env["PF_BYPASS_AUTH"]
for (const args of [
  ["cli/pfcli/src/main.ts", "import", org],
  ["apps/frontend-e2e/scripts/run-sso-runtime.mjs"],
]) {
  const result = spawnSync(process.execPath, args, { env, stdio: "inherit" })
  if (result.error) throw result.error
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1
    break
  }
}
