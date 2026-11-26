import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test } from "bun:test"

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "queue-runner-test-"))
  directories.push(dir)
  copyFileSync(join(import.meta.dir, "check.ts"), join(dir, "check.ts"))
  const checker = join(dir, "fake checker.ts")
  writeFileSync(
    checker,
    `
const args = process.argv.slice(2)
const config = args[args.indexOf("-config") + 1]
if (args[0] !== "quoted argument") process.exit(99)
if (!process.env.JAVA_TOOL_OPTIONS) process.exit(98)
if (process.env.FAKE_SIGNAL) process.kill(process.pid, "SIGTERM")
process.stdout.write(process.env.FAKE_TEXT ?? "Model checking completed. No error has been found.\\n10 states generated, 5 distinct states found\\n")
process.stderr.write(process.env.FAKE_STDERR ?? "")
if (process.env.FAKE_HANG) await Bun.sleep(60_000)
process.exit(Number(process.env.FAKE_EXIT ?? "0"))
`,
  )
  function run(
    name = "admission",
    env: Record<string, string> = {},
    args: string[] = [],
  ) {
    return Bun.spawnSync(
      [
        process.execPath,
        join(dir, "check.ts"),
        "--case",
        name,
        "--output",
        join(dir, "output"),
        ...args,
      ],
      {
        env: {
          ...process.env,
          TLC: `${process.execPath} "${checker}" 'quoted argument'`,
          ...env,
        },
      },
    )
  }
  return {
    dir,
    checker,
    run,
    results: () =>
      JSON.parse(readFileSync(join(dir, "output/results.json"), "utf8")),
    log: (name = "admission") =>
      readFileSync(join(dir, `output/${name}.log`), "utf8"),
    config: (text: string) =>
      writeFileSync(join(dir, "starvation-fresh.cfg"), text),
  }
}

test("preserves quoted TLC argv, deterministic options, merged logs and last state count", () => {
  const f = fixture()
  const result = f.run("admission", {
    FAKE_TEXT:
      "1 states generated, 1 distinct states found\nModel checking completed. No error has been found.\n12,345 states generated, 6,789 distinct states found\n",
    FAKE_STDERR: "checker stderr\n",
  })
  expect(result.exitCode).toBe(0)
  const [entry] = f.results()
  expect(entry).toMatchObject({
    case: "admission",
    verdict: "VERIFIED",
    exit: 0,
    error: null,
    property: null,
    distinct_states: 6789,
  })
  expect(entry.command).toEqual([
    process.execPath,
    f.checker,
    "quoted argument",
    "-workers",
    "1",
    "-fp",
    "0",
    "-seed",
    "1",
    "-metadir",
    join(f.dir, "output/admission"),
    "-config",
    join(f.dir, "admission.cfg"),
    join(f.dir, "Admission.tla"),
  ])
  expect(f.log()).toContain("checker stderr")
  expect(result.stdout.toString()).toContain(
    `Evidence: ${join(f.dir, "output")}`,
  )
})

test.each([
  ["enqueue-inner-return", "Invariant ReturnsAreDurable is violated.", "12", 0],
  ["enqueue-inner-return", "Invariant Other is violated.", "12", 1],
  ["enqueue-inner-return", "Invariant ReturnsAreDurable is violated.", "0", 1],
  ["admission", "Model checking completed. No error has been found.", "1", 1],
  ["admission", "Tool failed before checking", "0", 1],
  [
    "starvation-fresh",
    "Temporal properties were violated.\nBack to state 1",
    "13",
    0,
  ],
  ["starvation-fresh", "Temporal properties were violated.", "13", 1],
  [
    "starvation-fresh",
    "Temporal properties were violated.\nBack to state 1",
    "12",
    1,
  ],
])(
  "requires matching output and exit for %s: %s (%s)",
  (name, text, code, expectedExit) => {
    const f = fixture()
    f.config("PROPERTY EventuallyAttempted")
    expect(f.run(name, { FAKE_TEXT: text, FAKE_EXIT: code }).exitCode).toBe(
      expectedExit,
    )
    expect(f.results()[0].verdict).toBe(
      expectedExit === 0 ? "COUNTEREXAMPLE" : "UNEXPECTED",
    )
  },
)

test.each([
  [
    'PROPERTIES\nEventuallyAttempted\nCONSTANT Value = "PROPERTY"\n(* outer (* nested *) PROPERTY Wrong *)\n\\* PROPERTY Wrong',
    0,
  ],
  ["PROPERTY EventuallyAttempted\nPROPERTY Other", 1],
  ["PROPERTIES EventuallyAttempted Other", 1],
  ['CONSTANT Value = "PROPERTY"\n\\* PROPERTY EventuallyAttempted', 1],
  ["PROPERTY EventuallyAttempted\n(* unterminated", 1],
])("binds temporal counterexamples to parsed config: %s", (config, code) => {
  const f = fixture()
  f.config(config)
  expect(
    f.run("starvation-fresh", {
      FAKE_TEXT: "Temporal properties were violated.\nBack to state 1",
      FAKE_EXIT: "13",
    }).exitCode,
  ).toBe(code)
  if (code) {
    expect(f.results()[0]).toMatchObject({
      exit: null,
      verdict: "UNEXPECTED",
      command: [],
    })
    expect(f.log("starvation-fresh")).toContain("Runner error:")
  }
})

test.each(["", "   ", "'unterminated", "command\\", "/does/not/exist/tlc"])(
  "records runner errors for TLC=%j",
  (TLC) => {
    const f = fixture()
    expect(f.run("admission", { TLC }).exitCode).toBe(1)
    expect(f.results()[0]).toMatchObject({ verdict: "UNEXPECTED", exit: null })
    expect(f.results()[0].error).toBeString()
    expect(f.log()).toContain("Runner error:")
  },
)

test("timeout kills the checker and retains partial evidence", () => {
  const f = fixture()
  expect(
    f.run("admission", { FAKE_TEXT: "partial evidence\n", FAKE_HANG: "1" }, [
      "--timeout",
      "0.2",
    ]).exitCode,
  ).toBe(1)
  expect(f.results()[0]).toMatchObject({
    exit: null,
    error: "TLC exceeded the 0.2s case timeout",
    verdict: "UNEXPECTED",
  })
  expect(f.log()).toContain("partial evidence")
})

test("signal termination retains subprocess's negative signal exit", () => {
  const f = fixture()
  expect(f.run("admission", { FAKE_SIGNAL: "1" }).exitCode).toBe(1)
  expect(f.results()[0].exit).toBe(-15)
})

test.each(["0", "-1", "NaN", "Infinity"])(
  "rejects invalid timeout %s",
  (timeout) => {
    const f = fixture()
    expect(f.run("admission", {}, ["--timeout", timeout]).exitCode).toBe(2)
  },
)

test("rejects unknown cases and supports help", () => {
  const f = fixture()
  expect(f.run("unknown").exitCode).toBe(2)
  expect(f.run("").exitCode).toBe(2)
  expect(f.run("admission", {}, ["--help"]).exitCode).toBe(0)
})

test("large finite timeouts do not overflow and kill a successful checker", () => {
  const f = fixture()
  const result = f.run("admission", {}, ["--timeout", "2147484"])
  expect(result.exitCode).toBe(0)
  expect(f.results()[0]).toMatchObject({
    verdict: "VERIFIED",
    error: null,
    exit: 0,
  })
  expect(result.stderr.toString()).not.toContain("TimeoutOverflowWarning")
})
