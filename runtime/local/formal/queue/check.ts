#!/usr/bin/env bun
// Run TLC exhaustively; distinguish expected counterexamples from tool errors.
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { constants, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"

// Counterexamples are findings, not successful product guarantees.
// TLC 2.19 exits 12 for invariant and 13 for temporal-property violations.
const cases: ReadonlyArray<readonly [string, string, string | null]> = [
  ["admission", "Admission", null],
  ["enqueue-autocommit", "Enqueue", null],
  ["enqueue-after-commit", "Enqueue", null],
  ["enqueue-inner-return", "Enqueue", "ReturnsAreDurable"],
  ["enqueue-early-log", "Enqueue", "AnnouncementsAreDurable"],
  ["enqueue-rollback-log", "Enqueue", "NoRolledBackAnnouncement"],
  ["finite-success", "Lifecycle", null],
  ["finite-failures", "Lifecycle", null],
  ["cooperative-finite", "Cooperative", null],
  ["terminal-finite", "Terminal", null],
  ["terminal-arrivals", "Terminal", null],
  ["supervised-finite", "Supervised", null],
  ["observation-finite", "Observable", null],
  ["observation-arrivals", "Observable", null],
  ["starvation-fresh", "Lifecycle", "EventuallyAttempted"],
  ["starvation-retry", "Lifecycle", "EventuallySettled"],
  ["oldest-still-starves-retry", "Lifecycle", "EventuallySettled"],
  ["fifo-control", "Lifecycle", null],
  ["hung-handler", "Lifecycle", "EventuallyAttempted"],
  ["dead-letter-retained", "Lifecycle", "EventuallyRemoved"],
  ["final-attempt-crash", "Lifecycle", "EventuallyRecordedOutcome"],
  ["unhandled-queue", "Lifecycle", "EventuallyAttempted"],
  ["zero-attempt-budget", "Lifecycle", "EventuallyAttempted"],
]

const configHeaders = new Set(
  (
    "CONSTANT CONSTANTS CONSTRAINT CONSTRAINTS ACTION_CONSTRAINT " +
    "ACTION_CONSTRAINTS INVARIANT INVARIANTS INIT NEXT VIEW SYMMETRY " +
    "SPECIFICATION PROPERTY PROPERTIES TYPE TYPE_CONSTRAINT CHECK_DEADLOCK " +
    "ALIAS POSTCONDITION"
  ).split(" "),
)

function* configTokens(text: string): Generator<string> {
  const tokenPattern = /\s+|"(?:\\.|[^"\\])*"|[A-Za-z_][A-Za-z_0-9]*|./sy
  let position = 0
  let depth = 0
  while (position < text.length) {
    if (text.startsWith("(*", position)) {
      depth += 1
      position += 2
    } else if (depth) {
      if (text.startsWith("*)", position)) {
        depth -= 1
        position += 2
      } else {
        position += 1
      }
    } else if (text.startsWith("\\*", position)) {
      const end = text.indexOf("\n", position)
      position = end === -1 ? text.length : end + 1
    } else {
      tokenPattern.lastIndex = position
      const match = tokenPattern.exec(text)
      if (!match) throw new Error("Invalid cfg token")
      position = tokenPattern.lastIndex
      if (match[0].trim()) yield match[0]
    }
  }
  if (depth) throw new Error("Unterminated cfg comment")
}

function temporalProperties(config: string): string[] {
  const properties: string[] = []
  let collecting = false
  for (const token of configTokens(readFileSync(config, "utf8"))) {
    if (configHeaders.has(token)) {
      collecting = token === "PROPERTY" || token === "PROPERTIES"
    } else if (collecting) {
      properties.push(token)
    }
  }
  return properties
}

// POSIX shlex.split semantics: quoting/escaping, but no shell expansion/execution.
function splitCommand(input: string): string[] {
  const words: string[] = []
  let word = ""
  let started = false
  let quote: "'" | '"' | undefined
  for (let i = 0; i < input.length; i++) {
    const char = input.charAt(i)
    if (quote === "'") {
      if (char === "'") quote = undefined
      else word += char
    } else if (char === "\\") {
      const next = input.charAt(++i)
      if (!next) throw new Error("No escaped character")
      word +=
        quote === '"' && next !== '"' && next !== "\\" ? `\\${next}` : next
      started = true
    } else if (quote === '"') {
      if (char === '"') quote = undefined
      else word += char
    } else if (char === "'" || char === '"') {
      quote = char
      started = true
    } else if (" \t\r\n".includes(char)) {
      if (started) words.push(word)
      word = ""
      started = false
    } else {
      word += char
      started = true
    }
  }
  if (quote) throw new Error("No closing quotation")
  if (started) words.push(word)
  if (!words.length) throw new Error("TLC command must not be empty")
  return words
}

async function main(): Promise<number> {
  let args: ReturnType<typeof options>
  try {
    args = options()
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    )
    return 2
  }
  if (args.help) {
    process.stdout.write(
      "Usage: check.ts [--output PATH] [--case NAME] [--timeout SECONDS]\nRun TLC exhaustively; per-case timeout defaults to 180 seconds.\n",
    )
    return 0
  }
  const here = import.meta.dir
  const output = resolve(
    args.output ?? mkdtempSync(join(tmpdir(), "local-queue-tlc-")),
  )
  mkdirSync(output, { recursive: true })
  const env = {
    ...process.env,
    JAVA_TOOL_OPTIONS:
      process.env["JAVA_TOOL_OPTIONS"] ?? "-Xmx1g -XX:+UseParallelGC",
  }
  const results = []
  for (const [name, module, violation] of cases) {
    if (args.case && name !== args.case) continue
    let command: string[] = []
    let exitCode: number | null = null
    let error: string | null = null
    let text = ""
    try {
      const config = join(here, `${name}.cfg`)
      if (violation !== null && module === "Lifecycle") {
        // Temporal-error output does not identify a property. Bind it to the cfg.
        const properties = temporalProperties(config)
        if (properties.length !== 1 || properties[0] !== violation) {
          throw new Error(
            `Expected exactly one temporal property ${violation}; configured properties: ${JSON.stringify(properties)}`,
          )
        }
      }
      command = [
        ...splitCommand(process.env["TLC"] ?? "tlc"),
        "-workers",
        "1",
        "-fp",
        "0",
        "-seed",
        "1",
        "-metadir",
        join(output, name),
        "-config",
        config,
        join(here, `${module}.tla`),
      ]
      // Both descriptors share one file offset, preserving merged output order.
      const logPath = join(output, `${name}.log`)
      const log = openSync(logPath, "w")
      try {
        const child = Bun.spawn(command, {
          cwd: output,
          env,
          stdout: log,
          stderr: log,
        })
        let timedOut = false
        const started = performance.now()
        // Timers accept at most 2^31-1 milliseconds. Re-arm long waits rather
        // than letting an otherwise valid timeout overflow to one millisecond.
        const expire = () => {
          const remaining = args.timeout - (performance.now() - started) / 1000
          if (remaining > 0) {
            timer = setTimeout(
              expire,
              Math.min(remaining * 1000, 2_147_483_647),
            )
          } else {
            timedOut = true
            child.kill("SIGKILL")
          }
        }
        let timer = setTimeout(
          expire,
          Math.min(args.timeout * 1000, 2_147_483_647),
        )
        try {
          const code = await child.exited
          if (timedOut) error = `TLC exceeded the ${args.timeout}s case timeout`
          else
            exitCode = child.signalCode
              ? -processSignal(child.signalCode)
              : code
        } finally {
          clearTimeout(timer)
        }
      } finally {
        closeSync(log)
        text = readFileSync(logPath, "utf8")
      }
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure)
    }
    if (error !== null) text += `\nRunner error: ${error}\n`
    writeFileSync(join(output, `${name}.log`), text)
    let expected: boolean
    let verdict: string
    if (violation === null) {
      expected =
        exitCode === 0 &&
        text.includes("Model checking completed. No error has been found.")
      verdict = "VERIFIED"
    } else if (module === "Enqueue") {
      expected =
        exitCode === 12 && text.includes(`Invariant ${violation} is violated.`)
      verdict = "COUNTEREXAMPLE"
    } else {
      expected =
        exitCode === 13 &&
        text.includes("Temporal properties were violated.") &&
        text.includes("Back to state")
      verdict = "COUNTEREXAMPLE"
    }
    const states = [
      ...text.matchAll(
        /([\d,]+) states generated, ([\d,]+) distinct states found/g,
      ),
    ]
    const distinct = states.at(-1)?.[2]
    const entry = {
      case: name,
      verdict: expected ? verdict : "UNEXPECTED",
      property: violation,
      exit: exitCode,
      error,
      distinct_states: distinct ? Number(distinct.replaceAll(",", "")) : null,
      command,
    }
    results.push(entry)
    writeFileSync(
      join(output, "results.json"),
      `${JSON.stringify(results, null, 2)}\n`,
    )
    process.stdout.write(
      `${entry.verdict.padEnd(16)} ${name.padEnd(32)} states=${entry.distinct_states}\n`,
    )
    if (!expected) process.stdout.write(`${text.slice(-6000)}\n`)
  }
  process.stdout.write(`Evidence: ${output}\n`)
  return results.every((result) => result.verdict !== "UNEXPECTED") ? 0 : 1
}

function options() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      output: { type: "string" },
      case: { type: "string" },
      timeout: { type: "string", default: "180" },
      help: { type: "boolean", short: "h" },
    },
  })
  const timeout = Number(values.timeout)
  if (!Number.isFinite(timeout) || timeout <= 0)
    throw new Error("timeout must be finite and positive")
  if (
    values.case !== undefined &&
    !cases.some(([name]) => name === values.case)
  )
    throw new Error(`Unknown case: ${values.case}`)
  return { ...values, timeout }
}

// Match Python subprocess's negative return codes for signal termination.
function processSignal(signal: NodeJS.Signals | number): number {
  return typeof signal === "number" ? signal : constants.signals[signal]
}

try {
  process.exitCode = await main()
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exitCode = 1
}
