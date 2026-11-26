import { resolve } from "node:path"
import { expect, test } from "bun:test"

const PFORG = resolve(import.meta.dir, "../src/main.ts")

const run = async (args: readonly string[]) => {
  const child = Bun.spawn([process.execPath, PFORG, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exitCode }
}

// Parser failures happen before handlers, so exercise the actual command runner.
test.each(
  [
    ["--log-level", "error", "records", "list", "/all", "--page", "nope"],
    ["--log-level=error", "records", "get", "/all"],
    ["--log-level", "error", "lists", "describe"],
    ["--log-level", "error", "lists", "list", "--unknown"],
    ["records", "--log-level", "error", "list", "/all", "--page", "nope"],
    ["records", "list", "/all", "--log-level", "nope"],
    ["--log-level", "nope", "lists", "list"],
    ["--log-level=nope", "records", "get", "/all", "id"],
    ["--completions", "nope", "lists", "describe", "/all"],
  ].map((args) => ({ args })),
)("List parser errors remain JSON with global flags: %j", async ({ args }) => {
  const result = await run(args)
  expect(result).toMatchObject({ exitCode: 1, stdout: "" })
  expect(JSON.parse(result.stderr)).toMatchObject({
    error: { code: "COMMAND_FAILED", message: expect.any(String) },
  })
})

test("legacy commands retain text errors even with a List command as an argument", async () => {
  const result = await run([
    "--log-level",
    "error",
    "process",
    "start",
    "records",
    "--unknown",
  ])
  expect(result).toMatchObject({ exitCode: 1, stdout: "" })
  expect(result.stderr).toStartWith("❌ ")
})

// A command name used as a flag value must not select that command's format.
test("invalid global values do not select a List command for legacy errors", async () => {
  const result = await run(["--log-level", "records", "auth", "status"])
  expect(result).toMatchObject({ exitCode: 1, stdout: "" })
  expect(result.stderr).toStartWith("❌ ")
})

test("multiple parser diagnostics produce one JSON error retaining each diagnostic", async () => {
  const result = await run(["records", "get", "/all", "--unknown", "--other"])
  expect(result).toMatchObject({ exitCode: 1, stdout: "" })
  const error = JSON.parse(result.stderr).error
  expect(error.code).toBe("COMMAND_FAILED")
  expect(error.message).toContain("--unknown")
  expect(error.message).toContain("--other")
})
