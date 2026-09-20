import { randomUUID } from "node:crypto"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "bun:test"

for (const args of [
  [],
  ["--cli"],
  ["both"],
  ["desktop"],
  ["mobile"],
  ["desktop", "--cli"],
  ["--cli", "desktop"],
  ["--administration"],
  ["desktop", "--administration"],
  ["--administration", "desktop"],
  ["--issuance"],
  ["desktop", "--issuance"],
  ["--issuance", "desktop"],
  ["invalid", "--issuance"],
  ["invalid", "--administration"],
  ["invalid", "--cli"],
]) {
  test(`probe trailing arguments ${JSON.stringify(args)}`, () => {
    // Stop at the missing handoff after argument validation, before browser startup.
    const root = join(tmpdir(), `pf-probe-arguments-${randomUUID()}`)
    const result = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "delegation-lifecycle-probe.ts"),
        join(root, "handoff.json"),
        join(root, "evidence"),
        ...args,
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    const stderr = result.stderr.toString()
    expect(result.exitCode).not.toBe(0)
    if (args.includes("invalid")) {
      expect(stderr).toContain('actual "invalid"')
      expect(stderr).not.toContain("ENOENT")
    } else {
      expect(stderr).toContain("ENOENT")
      expect(stderr).not.toContain("ParseError")
    }
  })
}

test.each([
  "https://example.test/control",
  "http://localhost.example.test/control",
  "http://127.0.0.1@example.test/control",
])("issuance rejects non-loopback control %s before startup", (control) => {
  const root = mkdtempSync(join(tmpdir(), "pf-probe-control-"))
  const evidence = join(root, "evidence")
  try {
    const handoff = join(root, "handoff.json")
    writeFileSync(
      handoff,
      JSON.stringify({
        registrationUrl: "http://localhost:1/register",
        issuer: "http://localhost:1",
        frontend: "http://localhost:1",
        graphql: "http://localhost:1/graphql",
        frontendJwt: "test-frontend-token",
        policyPath: "unused",
        runtimeRoot: "unused",
        auditPath: "unused",
        reviewerRoleId: "unused",
        control,
        controlToken: "test-private-control-token",
        issuanceProbe: true,
      }),
      { mode: 0o600 },
    )
    const result = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "delegation-lifecycle-probe.ts"),
        handoff,
        evidence,
        "--issuance",
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain("Local probe only")
    expect(result.stderr.toString()).not.toContain("test-private-control-token")
    expect(existsSync(evidence)).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
