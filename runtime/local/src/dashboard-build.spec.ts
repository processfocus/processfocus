import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { dashboardOrganisationInputs } from "./dashboard-build"
import { expect, test } from "bun:test"

test("tracks Dashboard artifact and login changes without invalidating backend-only edits", async () => {
  const root = mkdtempSync(join(tmpdir(), "dashboard-inputs-"))
  let providers = ["passkey"]
  let openRegistration = false
  let issuerExtra = "first"
  const issuer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      Response.json({
        providers_supported: providers,
        passkey_open_registration: openRegistration,
        issuer: issuerExtra,
      }),
  })
  const write = (path: string, content: string): void => {
    const file = join(root, "dist", path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
  }
  const fingerprint = () =>
    dashboardOrganisationInputs({
      orgPath: root,
      authUrl: issuer.url.toString(),
    })
  try {
    write("frontend-manifest.json", '{"plugins":[]}')
    write("browser-plugins.json", '{"plugins":[]}')
    const original = await fingerprint()
    write("org.js", "updated backend model")
    write("graphql/org.graphql", "updated schema")
    issuerExtra = "second"
    expect(await fingerprint()).toBe(original)

    for (const path of [
      "frontend-manifest.json",
      "browser-plugins.json",
      "browser-plugins/plugin.js",
      "browser-plugins/plugin.css",
      "docs/process.md",
      "_pf/app-icons/icon.png",
      "_pf/public-form-branding/logo.svg",
    ]) {
      const before = await fingerprint()
      write(path, "first contents")
      const added = await fingerprint()
      expect(added).not.toBe(before)
      write(path, "second contents")
      const updated = await fingerprint()
      expect(updated).not.toBe(added)
      rmSync(join(root, "dist", path))
      if (path.endsWith(".json")) write(path, '{"plugins":[]}')
      expect(await fingerprint()).not.toBe(updated)
    }
    const beforeAuth = await fingerprint()
    openRegistration = true
    expect(await fingerprint()).not.toBe(beforeAuth)
    openRegistration = false
    providers = ["passkey", "google"]
    expect(await fingerprint()).not.toBe(beforeAuth)
    providers = ["passkey"]
    expect(await fingerprint()).toBe(original)
  } finally {
    await issuer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})
