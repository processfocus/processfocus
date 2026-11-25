import { describe, expect, it } from "vitest"
import {
  decodeDeployPhaseFailure,
  sanitizeDeployPhaseFailureReason,
} from "./deploy-phase-failure.js"

const failure = {
  format: "processfocus/deploy-phase-failure",
  version: 1,
  project: "0000-0000-0002",
  environment: "test",
  stage: "Staging",
  phase: "database",
  reason: "table `customer_order` already exists",
  statement: "CREATE TABLE `customer_order` (`id` text);",
}

describe("public deploy-phase diagnostics", () => {
  it.each([
    "TURSO_AUTH_TOKEN=private-sentinel",
    '"password": "private sentinel"',
    "Bearer private-sentinel",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwcml2YXRlIn0.private-sentinel",
    "eyJhbGciOiJIUzI1NiJ9.123456.signature-sentinel",
    "https://example.com/?X-Amz-Signature=private-sentinel",
    "libsql://user:private-sentinel@db.example.com?authToken=private-sentinel",
    "DEFAULT 'private-sentinel'",
    "DEFAULT 'private-sentinel",
    'DEFAULT "private-sentinel"',
    'DEFAULT "private""sentinel"',
    'DEFAULT "private-sentinel',
    `DEFAULT "owner's name", config DEFAULT '{"value":"private-sentinel"}'`,
    `DEFAULT 'quote " inside', config DEFAULT "owner's private-sentinel"`,
    "CREATE TABLE `owner's \"records\"` (value text DEFAULT 'private-sentinel')",
    "CREATE TABLE [owner's \"records\"] (value text DEFAULT 'private-sentinel')",
    "-- private-sentinel",
    "/* private-sentinel */",
    "0123456789abcdefghijklmnopqrstuvwxyz",
  ])(
    "redacts sensitive diagnostic content and rejects unsanitized transport: %s",
    (privateText) => {
      const reason = `${failure.reason}\n${privateText}`
      expect(decodeDeployPhaseFailure({ ...failure, reason })).toBeUndefined()
      expect(
        decodeDeployPhaseFailure({ ...failure, statement: privateText }),
      ).toBeUndefined()
      const sanitized = sanitizeDeployPhaseFailureReason(reason)
      expect(sanitized).toContain(failure.reason)
      expect(sanitized).not.toContain(privateText)
      expect(sanitized).not.toContain("sentinel")
      expect(
        decodeDeployPhaseFailure({ ...failure, reason: sanitized }),
      ).toBeDefined()
    },
  )

  it.each([
    "123456",
    "+123456",
    "-123456",
    ".123456",
    "123456.5",
    "1.23456e+5",
    "0x123456",
    "12_34_56",
    "1.23_45e6",
    "0x12_34_56",
  ])(
    "redacts numeric data and rejects unsanitized envelopes without hiding schema identifiers: %s",
    (literal) => {
      const statement = `INSERT INTO credentials_2026 (\`api_token_2\`) VALUES (${literal});`
      expect(
        decodeDeployPhaseFailure({ ...failure, statement }),
      ).toBeUndefined()
      expect(
        decodeDeployPhaseFailure({ ...failure, reason: statement }),
      ).toBeUndefined()
      const sanitized = sanitizeDeployPhaseFailureReason(statement)
      expect(sanitized).toMatch(
        /^INSERT INTO credentials_2026 \(`api_token_2`\) VALUES \([+-]?\[REDACTED\]\);$/,
      )
      expect(sanitized).not.toContain(literal.replace(/^[+-]/, ""))
      expect(
        decodeDeployPhaseFailure({ ...failure, statement: sanitized })
          ?.statement,
      ).toBe(sanitized)
    },
  )

  it.each([
    { clause: "DEFAULT private_sentinel", value: "private_sentinel" },
    { clause: "DEFAULT `private_sentinel`", value: "private_sentinel" },
    { clause: "DEFAULT/**/private_sentinel", value: "private_sentinel" },
    { clause: "DEFAULT 123456", value: "123456" },
    { clause: "DEFAULT (abs(123456))", value: "123456" },
    { clause: "DEFAULT (coalesce('a,b', 123456))", value: "123456" },
  ])(
    "redacts DEFAULT data while preserving the remaining columns: $clause",
    ({ clause, value }) => {
      const statement = `CREATE TABLE \`customer_order\` (\`api_token\` text ${clause}, \`id\` text)`
      expect(
        decodeDeployPhaseFailure({ ...failure, statement }),
      ).toBeUndefined()
      const sanitized = sanitizeDeployPhaseFailureReason(statement)
      expect(sanitized).toMatch(
        /^CREATE TABLE `customer_order` \(`api_token` text DEFAULT\s*\[REDACTED\], `id` text\)$/,
      )
      expect(sanitized).not.toContain(value)
      expect(
        decodeDeployPhaseFailure({ ...failure, statement: sanitized })
          ?.statement,
      ).toBe(sanitized)
    },
  )

  it.each([
    "CREATE TABLE `DEFAULT` (`DEFAULT value` text, `id` text)",
    "CREATE TABLE table_2026 (`123` text, field2 text)",
  ])(
    "preserves schema identifiers rather than treating them as data: %s",
    (statement) => {
      expect(sanitizeDeployPhaseFailureReason(statement)).toBe(statement)
      expect(
        decodeDeployPhaseFailure({ ...failure, statement })?.statement,
      ).toBe(statement)
    },
  )

  it("keeps DEFAULT diagnostics revalidatable when a private value overlaps separators", () => {
    const output =
      "CREATE TABLE `customer_order` (value text DEFAULT private_sentinel, id text)"
    const statement = sanitizeDeployPhaseFailureReason(output, [" "])
    expect(statement).not.toContain("private_sentinel")
    expect(statement).toContain("`customer_order`")
    expect(decodeDeployPhaseFailure({ ...failure, statement })).toBeDefined()
  })

  it.each([
    {
      output: `CREATE TABLE \`customer_order\` (a TEXT DEFAULT "owner's name", credentials TEXT DEFAULT '{"value":"private-sentinel"}')`,
      privateValue: 'name"',
      expected:
        "CREATE TABLE `customer_order` (a TEXT DEFAULT [REDACTED], credentials TEXT DEFAULT [REDACTED])",
    },
    {
      output:
        "Migration failed: private-sentinel's credential -> database error",
      privateValue: "private-sentinel's credential",
      expected: "Migration failed: [REDACTED]",
    },
    {
      output:
        "CREATE TABLE `customer_order` (value text DEFAULT 'private-sentinel')",
      privateValue: "order`",
      expected: "CREATE TABLE [REDACTED] (value text DEFAULT [REDACTED])",
    },
  ])(
    "redacts overlapping private values and quoted regions without changing their boundaries (%#)",
    ({ output, privateValue, expected }) => {
      const reason = sanitizeDeployPhaseFailureReason(output, [privateValue])
      expect(reason).toContain(expected)
      expect(reason).not.toContain("sentinel")
      expect(decodeDeployPhaseFailure({ ...failure, reason })).toBeDefined()
    },
  )

  it.each([
    "Migration failed: ".repeat(300),
    `${"x ".repeat(995)}'private-sentinel' trailing details`,
    `${"x ".repeat(991)}DEFAULT 'private-sentinel')`,
    `${"x ".repeat(995)}123456 trailing details`,
  ])(
    "bounds long diagnostics without losing the separate statement (%#)",
    (output) => {
      const reason = sanitizeDeployPhaseFailureReason(output)
      expect(reason.length).toBe(2000)
      expect(reason.endsWith("...")).toBe(true)
      expect(reason).not.toContain("sentinel")
      expect(reason).not.toContain("123456")
      expect(decodeDeployPhaseFailure({ ...failure, reason })?.statement).toBe(
        failure.statement,
      )
      expect(
        decodeDeployPhaseFailure({ ...failure, reason: "x".repeat(2001) }),
      ).toBeUndefined()
    },
  )
})
