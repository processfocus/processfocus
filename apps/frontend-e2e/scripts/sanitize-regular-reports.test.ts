/** Artifact boundary: failure details survive; captured credentials do not. */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { JSDOM } from "jsdom"
import { afterEach, beforeEach, expect, test } from "bun:test"

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sanitize-reports-"))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
function run() {
  return Bun.spawnSync(
    [
      process.execPath,
      join(import.meta.dir, "sanitize-regular-reports.ts"),
      root,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
}

test("missing or malformed JUnit fails without publishing safe evidence", () => {
  expect(run().exitCode).toBe(1)
  expect(existsSync(join(root, "regular-safe.xml"))).toBe(false)
  writeFileSync(join(root, "regular.xml"), "<broken")
  expect(run().exitCode).toBe(1)
  expect(existsSync(join(root, "regular-safe.xml"))).toBe(false)
})

test("uploaded reports retain failure details but remove credentials and captured output", () => {
  writeFileSync(
    join(root, "regular.xml"),
    '<testsuite><properties><property value="private-property"/></properties><testcase name="approval"><failure message="Bearer private-token">' +
      "Expected null, received undefined\neyJheader.payload.signature\nBearer <![CDATA[private-cdata]]>\nBasic <!-- split -->private-comment</failure>Authorization: Bearer private-tail" +
      "<system-out>private process log</system-out><system-err>private error log</system-err></testcase></testsuite>",
  )
  mkdirSync(join(root, "regular-output/test"), { recursive: true })
  writeFileSync(
    join(root, "regular-output/test/error-context.md"),
    "Approval dialog\nAuthorization: Basic private-basic\nCookie: private-cookie\nSet-Cookie: private-set-cookie\naccess_token=private-access-token\nrefresh_token: private-refresh-token",
  )
  const result = run()
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  const xml = readFileSync(join(root, "regular-safe.xml"), "utf8")
  const context = readFileSync(
    join(root, "regular-safe-output/test/error-context.md"),
    "utf8",
  )
  const dom = new JSDOM(xml, { contentType: "text/xml" })
  expect(dom.window.document.getElementsByTagName("failure")).toHaveLength(1)
  dom.window.close()
  expect(xml).toContain("Expected null, received undefined")
  expect(context).toContain("Approval dialog")
  for (const content of [xml, context]) {
    expect(content).not.toContain("private")
    expect(content).not.toContain("eyJheader")
  }
})

test("invalid UTF-8 fails closed rather than publishing credential fragments", () => {
  const invalid = Buffer.concat([
    Buffer.from("Authorization: Bearer "),
    Buffer.from([0xff]),
    Buffer.from("private-token"),
  ])
  writeFileSync(join(root, "regular.xml"), "<testsuite/>")
  mkdirSync(join(root, "regular-output/test"), { recursive: true })
  writeFileSync(join(root, "regular-output/test/error-context.md"), invalid)
  expect(run().exitCode).toBe(1)
  expect(
    existsSync(join(root, "regular-safe-output/test/error-context.md")),
  ).toBe(false)

  rmSync(join(root, "regular-output"), { recursive: true })
  rmSync(join(root, "regular-safe.xml"), { force: true })
  writeFileSync(
    join(root, "regular.xml"),
    Buffer.concat([
      Buffer.from("<testsuite><testcase><failure>"),
      invalid,
      Buffer.from("</failure></testcase></testsuite>"),
    ]),
  )
  expect(run().exitCode).toBe(1)
  expect(existsSync(join(root, "regular-safe.xml"))).toBe(false)
})

test("Unicode separators do not split credential lines during redaction", () => {
  mkdirSync(join(root, "regular-output/test"), { recursive: true })
  for (const separator of ["\u2028", "\u2029"]) {
    const text = `Before\nCookie: session=abc${separator}private-cookie\naccess_token=abc${separator}private-token\nAfter`
    writeFileSync(
      join(root, "regular.xml"),
      `<testsuite><testcase><failure>${text}</failure></testcase></testsuite>`,
    )
    writeFileSync(join(root, "regular-output/test/error-context.md"), text)
    const result = run()
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    const expected = "Before\n[REDACTED]\n[REDACTED]\nAfter"
    expect(
      readFileSync(
        join(root, "regular-safe-output/test/error-context.md"),
        "utf8",
      ),
    ).toBe(expected)
    const dom = new JSDOM(
      readFileSync(join(root, "regular-safe.xml"), "utf8"),
      { contentType: "text/xml" },
    )
    expect(dom.window.document.querySelector("failure")?.textContent).toBe(
      expected,
    )
    dom.window.close()
  }
})

test("Python whitespace and case variants still redact credential lines", () => {
  writeFileSync(join(root, "regular.xml"), "<testsuite/>")
  mkdirSync(join(root, "regular-output/test"), { recursive: true })
  const lines = [
    ...["\u001c", "\u001d", "\u001e", "\u001f", "\u0085"].map(
      (space) => `cookie${space}=secret`,
    ),
    "Cookıe: secret",
    "Cookİe: secret",
    "acceſſ_token=secret",
  ]
  const authLines = ["\u001c", "\u001d", "\u001e", "\u001f", "\u0085"].map(
    (space) => `Authorization: Bearer${space}secret`,
  )
  authLines.push("Authorization: Basıc secret", "Authorization: Baſİc secret")
  writeFileSync(
    join(root, "regular-output/test/error-context.md"),
    [...lines, ...authLines].join("\n"),
  )
  expect(run().exitCode).toBe(0)
  expect(
    readFileSync(
      join(root, "regular-safe-output/test/error-context.md"),
      "utf8",
    ),
  ).toBe(
    [
      ...lines.map(() => "[REDACTED]"),
      ...authLines.slice(0, 5).map(() => "Authorization: Bearer [REDACTED]"),
      "Authorization: Basıc [REDACTED]",
      "Authorization: Baſİc [REDACTED]",
    ].join("\n"),
  )
})

test("UTF-16 JUnit preserves diagnostics and redaction", () => {
  const xml =
    '\ufeff<?xml version="1.0" encoding="utf-16"?><testsuite><testcase><failure>Failure résumé: Bearer private-token</failure></testcase></testsuite>'
  for (const bytes of [
    Buffer.from(xml, "utf16le"),
    Buffer.from(xml, "utf16le").swap16(),
  ]) {
    writeFileSync(join(root, "regular.xml"), bytes)
    expect(run().exitCode).toBe(0)
    const output = readFileSync(join(root, "regular-safe.xml"), "utf8")
    expect(output).toContain("Failure résumé: Bearer [REDACTED]")
    expect(output).not.toContain("private-token")
  }
})

test("hidden directories retain sanitized error contexts", () => {
  writeFileSync(join(root, "regular.xml"), "<testsuite/>")
  mkdirSync(join(root, "regular-output/.hidden"), { recursive: true })
  writeFileSync(
    join(root, "regular-output/.hidden/error-context.md"),
    "Failure detail\nCookie: private-token",
  )
  expect(run().exitCode).toBe(0)
  expect(
    readFileSync(
      join(root, "regular-safe-output/.hidden/error-context.md"),
      "utf8",
    ),
  ).toBe("Failure detail\n[REDACTED]")
})

test("valid JUnit does not require a browser context directory", () => {
  writeFileSync(join(root, "regular.xml"), "<testsuite><testcase/></testsuite>")
  expect(run().exitCode).toBe(0)
  expect(existsSync(join(root, "regular-safe.xml"))).toBe(true)
})
