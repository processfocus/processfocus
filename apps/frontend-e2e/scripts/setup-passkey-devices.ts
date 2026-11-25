import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export default function setupPasskeyDevices() {
  const directory = mkdtempSync(join(tmpdir(), "pf-dashboard-passkeys-"))
  process.env["FRONTEND_E2E_PASSKEY_DIRECTORY"] = directory
  return () => rmSync(directory, { recursive: true, force: true })
}
