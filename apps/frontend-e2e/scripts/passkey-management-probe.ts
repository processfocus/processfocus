/// <reference lib="dom" />
import assert from "node:assert/strict"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { chromium } from "@playwright/test"
import { Schema } from "effect"

// Run with the private handoff from PASSKEY_MANAGEMENT_PROBE=true
// bun runtime/local/scripts/delegation-next-runtime.ts. All visible interactions
// use agent-browser; CDP only supplies independent virtual authenticators.
const handoffPath = process.argv[2]
const evidence = Schema.decodeUnknownSync(Schema.NonEmptyString)(
  process.argv[3],
)
assert(
  handoffPath && evidence,
  "Expected private handoff and evidence directory",
)
const handoff = Schema.decodeUnknownSync(
  Schema.Struct({
    registrationUrl: Schema.String,
    frontend: Schema.String,
    runtimeRoot: Schema.String,
  }),
)(JSON.parse(readFileSync(handoffPath, "utf8")))
assert.equal(new URL(handoff.frontend).hostname, "localhost")
mkdirSync(evidence, { recursive: true })
const session = `passkeys-${process.pid}`
const checks: string[] = []
async function ab(...args: string[]): Promise<string> {
  const child = Bun.spawn(["agent-browser", "--session", session, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  assert.equal(code, 0, `${args[0]} failed: ${stderr}`)
  return stdout
}
async function button(name: string) {
  await ab("find", "role", "button", "click", "--name", name, "--exact")
}
async function text(value: string) {
  await ab("wait", "--text", value)
}
function record(check: string) {
  checks.push(check)
  console.info(check)
  writeFileSync(join(evidence, "checks.json"), JSON.stringify(checks, null, 2))
}
const Audit = Schema.Struct({
  users: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      provider: Schema.String,
      sub: Schema.String,
    }),
  ),
  providerUsers: Schema.Array(Schema.Unknown),
  roles: Schema.Array(Schema.Unknown),
  invitations: Schema.Array(Schema.Unknown),
  credentials: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      userId: Schema.String,
      credentialId: Schema.String,
      name: Schema.NullOr(Schema.String),
      lastUsedAt: Schema.NullOr(Schema.Unknown),
      deleted: Schema.Boolean,
    }),
  ),
})
function audit() {
  return Schema.decodeUnknownSync(Audit)(
    JSON.parse(
      readFileSync(join(handoff.runtimeRoot, "passkey-audit.json"), "utf8"),
    ),
  )
}
async function auditCount(count: number) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const current = audit()
    if (current.credentials.filter((c) => !c.deleted).length === count)
      return current
    await Bun.sleep(100)
  }
  throw Error(`Expected ${count} active credentials`)
}
await ab("open", `${handoff.frontend}/login`)
await ab("set", "viewport", "1440", "1000")
const connection = Schema.decodeUnknownSync(
  Schema.Struct({ data: Schema.Struct({ cdpUrl: Schema.String }) }),
)(JSON.parse(await ab("get", "cdp-url", "--json")))
const browser = await chromium.connectOverCDP(connection.data.cdpUrl)
const context = browser.contexts()[0]
assert(context)
const page = context.pages().find((p) => p.url().startsWith(handoff.frontend))
assert(page)
const listingReady = new Promise<void>((resolve) => {
  page.on("response", async (response) => {
    if (
      response.request().method() !== "POST" ||
      new URL(response.url()).pathname !== "/"
    )
      return
    const body = await response.text().catch(() => "")
    if (body.includes('"credentials"') && body.includes('"kind":"success"'))
      resolve()
  })
})
const cdp = await context.newCDPSession(page)
await cdp.send("WebAuthn.enable")
async function authenticator() {
  return (
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        ctap2Version: "ctap2_1",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    })
  ).authenticatorId
}
let active = await authenticator()
try {
  await ab("open", handoff.registrationUrl)
  await text("Create passkey")
  await button("Create passkey")
  await ab("wait", "--fn", "location.pathname === '/'")
  await text("lifecycle-owner@example.test")
  const original = (
    await cdp.send("WebAuthn.getCredentials", { authenticatorId: active })
  ).credentials[0]
  assert(original)
  await Promise.race([
    listingReady,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("Profile listing did not load")),
        30000,
      ),
    ),
  ])
  await ab(
    "wait",
    "--fn",
    "document.querySelector('[data-testid=header-profile-button]') !== null",
  )
  await ab("click", '[data-testid="header-profile-button"]')
  await text("Passkeys")
  await ab("click", 'a[href="/passkeys"]')
  await text("Unnamed passkey")
  await text("Unknown")
  await text("TBS New Zealand")
  const baseline = await auditCount(1)
  record(
    "Ordinary invited human reached Passkeys through profile menu; organisation, unnamed and unknown fallbacks visible",
  )
  await ab("screenshot", join(evidence, "after-list.png"))
  await ab("fill", '[aria-label="Name for the new Passkey"]', "Spare key")
  await button("Add Passkey")
  await text("already registered")
  assert.equal((await auditCount(1)).credentials.length, 1)
  record(
    "Existing authenticator excluded; duplicate rejected with no new credential",
  )
  await cdp.send("WebAuthn.removeVirtualAuthenticator", {
    authenticatorId: active,
  })
  active = await authenticator()
  // Abort a real pending navigator.credentials.create call. No credential or
  // network response is mocked; disable virtual presence until the abort fires.
  await cdp.send("WebAuthn.setAutomaticPresenceSimulation", {
    authenticatorId: active,
    enabled: false,
  })
  await ab(
    "eval",
    `(() => {
    const nativeCreate = navigator.credentials.create.bind(navigator.credentials);
    navigator.credentials.create = options => {
      navigator.credentials.create = nativeCreate;
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("User cancelled", "NotAllowedError")), 150);
      return nativeCreate({ ...options, signal: controller.signal });
    };
  })()`,
  )
  await button("Add Passkey")
  await text("Registration was cancelled")
  assert.equal((await auditCount(1)).credentials.length, 1)
  record(
    "Real pending creation cancelled via AbortSignal; no credential persisted and retry remains available",
  )
  await cdp.send("WebAuthn.setAutomaticPresenceSimulation", {
    authenticatorId: active,
    enabled: true,
  })
  await button("Add Passkey")
  await text("Passkey added")
  const spare = (
    await cdp.send("WebAuthn.getCredentials", { authenticatorId: active })
  ).credentials[0]
  assert(spare)
  assert.notEqual(spare.credentialId, original.credentialId)
  const added = await auditCount(2)
  assert.equal(added.credentials[0]?.userId, added.credentials[1]?.userId)
  assert.deepEqual(added.users, baseline.users)
  assert.deepEqual(added.providerUsers, baseline.providerUsers)
  assert.deepEqual(added.roles, baseline.roles)
  assert.deepEqual(added.invitations, baseline.invitations)
  record(
    "Independent spare persisted on same account using existing session; identity, roles and accepted Invitation unchanged",
  )
  await ab("fill", '[aria-label="Name for Unnamed passkey"]', "   ")
  await ab(
    "click",
    'article:has([aria-label="Name for Unnamed passkey"]) button[type="submit"]',
  )
  await text("Enter a name")
  await ab("fill", '[aria-label="Name for Unnamed passkey"]', "Spare key")
  await ab(
    "click",
    'article:has([aria-label="Name for Unnamed passkey"]) button[type="submit"]',
  )
  await text("Passkey name saved")
  await ab("screenshot", join(evidence, "after-two-passkeys.png"))
  record(
    "Rename persisted; duplicate labels permitted; creation dates rendered",
  )
  // Sign in with one independent authenticator at a time. Clear only cookies;
  // retain a copy to later prove removal preserves the established session.
  const establishedCookies = await context.cookies()
  for (const credential of [original, spare]) {
    await cdp.send("WebAuthn.removeVirtualAuthenticator", {
      authenticatorId: active,
    })
    active = await authenticator()
    await cdp.send("WebAuthn.addCredential", {
      authenticatorId: active,
      credential,
    })
    await context.clearCookies()
    await ab("open", `${handoff.frontend}/login`)
    await text("Sign in with Passkey")
    await button("Sign in with Passkey")
    await ab("wait", "--fn", "location.pathname === '/'")
    await text("lifecycle-owner@example.test")
    await ab("open", `${handoff.frontend}/passkeys`)
    await text("Spare key")
    const updated = (
      await cdp.send("WebAuthn.getCredentials", { authenticatorId: active })
    ).credentials[0]
    assert(updated)
    credential.signCount = updated.signCount
  }
  const signedIn = await auditCount(2)
  assert(signedIn.credentials.every((c) => c.lastUsedAt !== null))
  assert.deepEqual(signedIn.users, baseline.users)
  assert.deepEqual(signedIn.roles, baseline.roles)
  assert.deepEqual(signedIn.invitations, baseline.invitations)
  record(
    "Both independent credentials sign in to same account; credential-specific last-used recorded; roles and Invitation unchanged",
  )
  // Remove the first row via its visible confirmation.
  const originalRow = baseline.credentials[0]
  assert(originalRow)
  await ab(
    "click",
    `[data-passkey-id="${originalRow.id}"] [data-testid="passkey-remove"]`,
  )
  await text("remain signed in")
  await ab("screenshot", join(evidence, "after-confirm-removal.png"))
  await ab("click", '[data-testid="passkey-confirm-remove"]')
  await text("Passkey removed")
  const remaining = await auditCount(1)
  assert.equal(remaining.credentials.filter((c) => !c.deleted).length, 1)
  await ab("click", '[data-testid="passkey-remove"]')
  await text("replacement")
  await ab("screenshot", join(evidence, "after-final-protected.png"))
  record(
    "Removal confirmation explains existing sessions; last credential protected",
  )
  // Restore the actual previously issued session, never a fabricated token.
  await context.clearCookies()
  await context.addCookies(establishedCookies)
  await ab("open", `${handoff.frontend}/passkeys`)
  await text("Spare key")
  record("Session issued before credential removal remains authorized")
  await cdp.send("WebAuthn.removeVirtualAuthenticator", {
    authenticatorId: active,
  })
  active = await authenticator()
  await cdp.send("WebAuthn.addCredential", {
    authenticatorId: active,
    credential: original,
  })
  await context.clearCookies()
  await ab("open", `${handoff.frontend}/login`)
  await text("Sign in with Passkey")
  await button("Sign in with Passkey")
  await text("Passkey verification failed")
  record("Removed credential rejected by real sign-in ceremony")
  await cdp.send("WebAuthn.removeVirtualAuthenticator", {
    authenticatorId: active,
  })
  active = await authenticator()
  await cdp.send("WebAuthn.addCredential", {
    authenticatorId: active,
    credential: spare,
  })
  await button("Sign in with Passkey")
  await ab("wait", "--fn", "location.pathname === '/'")
  await ab("open", `${handoff.frontend}/passkeys`)
  await text("Spare key")
  record("Remaining spare still signs in after removal")
} finally {
  await browser.close()
  await ab("close")
}
