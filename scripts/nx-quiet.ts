#!/usr/bin/env bun

/**
 * Wrapper around nx commands that suppresses verbose successful task output.
 * Prints a short success sentinel and only shows detailed output for tasks that fail,
 * reducing token usage for Claude Code.
 *
 * Strategy:
 * - Success (exit 0): suppress Nx output and print `completed successfully`
 * - Failure (exit non-zero): show only terminal outputs from failed tasks
 * - Stream task-start lines and a 30s heartbeat so CI stall timeouts stay
 *   diagnosable
 * - Drain stdout/stderr while Nx runs so a large log cannot deadlock the child
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join, relative, resolve } from "node:path"
import { stripVTControlCharacters } from "node:util"

const args = process.argv.slice(2)

if (args.length === 0) {
  console.error("Usage: bun scripts/nx-quiet.ts <nx-command> [args...]")
  console.error("Example: bun scripts/nx-quiet.ts affected -t lint,test")
  process.exit(1)
}

const startTime = Date.now()

const inheritIo = process.env["NX_QUIET_INHERIT"] === "1"
const tracingEnabled =
  process.env["GITHUB_ACTIONS"] === "true" &&
  process.env["PF_NX_CI_TRACING"] === "true"

const isProgressLine = (line: string): boolean => {
  const plain = stripVTControlCharacters(line)
  return (
    /^\s*> nx run /.test(plain) ||
    /^ NX {3}Running target /.test(plain) ||
    /^ NX {3}Successfully ran /.test(plain)
  )
}

const collectStream = async (
  stream: ReadableStream<Uint8Array> | undefined,
  forwardProgress: boolean,
): Promise<string> => {
  if (!stream) return ""
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let full = ""
  let buf = ""
  const consumeLine = (line: string): void => {
    if (forwardProgress && isProgressLine(line)) console.log(line)
  }
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = decoder.decode(value, { stream: true })
    full += chunk
    buf += chunk
    let newline = buf.indexOf("\n")
    while (newline >= 0) {
      consumeLine(buf.slice(0, newline))
      buf = buf.slice(newline + 1)
      newline = buf.indexOf("\n")
    }
  }
  const flushed = decoder.decode()
  full += flushed
  buf += flushed
  if (buf.length > 0) consumeLine(buf)
  return full
}

// Release version/changelog commands reject task-runner output/batch options.
const isRelease = args[0] === "release"
const nxArgs = [
  "bun",
  "nx",
  ...(isRelease ? [] : ["--outputStyle=stream"]),
  ...args,
]
if (
  !isRelease &&
  !inheritIo &&
  !args.some((arg) => arg === "--batch" || arg.startsWith("--batch="))
)
  nxArgs.push("--batch")

// A unique profile per invocation preserves nested and sequential task/cache
// observations without capturing command arguments, environment or test output.
const evidenceDirectory = process.env["PR_REVIEW_EVIDENCE_DIR"]
let evidenceProfile: string | undefined
if (evidenceDirectory) {
  mkdirSync(evidenceDirectory, { recursive: true })
  const profileLabel = (
    process.env["PR_REVIEW_PROFILE_LABEL"] ?? "tasks"
  ).replace(/[^a-zA-Z0-9_-]/g, "_")
  evidenceProfile = join(
    evidenceDirectory,
    `nx-${profileLabel}-${process.pid}-${startTime}.json`,
  )
}

const diagnosticsRoot = resolve(".nx/workspace-data/nx-quiet")
if (!inheritIo) mkdirSync(diagnosticsRoot, { recursive: true })
const diagnosticsDirectory = inheritIo
  ? ""
  : mkdtempSync(join(diagnosticsRoot, "run-"))

const proc = Bun.spawn(nxArgs, {
  env: {
    ...process.env,
    ...(!inheritIo
      ? {
          NX_QUIET_RESULTS: join(diagnosticsDirectory, "failures.json"),
          NX_QUIET_COMMAND: JSON.stringify(nxArgs.slice(2)),
        }
      : {}),
    ...(evidenceProfile
      ? { NX_PROFILE: relative(process.cwd(), resolve(evidenceProfile)) }
      : {}),
    NX_NO_CLOUD: "true",
    NX_DAEMON: "false",
  },
  stdout: inheritIo ? "inherit" : "pipe",
  stderr: inheritIo ? "inherit" : "pipe",
  stdin: "inherit",
})

const heartbeat = setInterval(() => {
  const elapsed = Math.round((Date.now() - startTime) / 1000)
  console.log(`still running (${elapsed}s)`)
}, 30_000)

if (inheritIo) {
  const exitCode = (await proc.exited) ?? 1
  clearInterval(heartbeat)
  process.exit(exitCode)
}

const [stdoutRaw, stderrRaw, rawExitCode] = await Promise.all([
  collectStream(proc.stdout, true),
  collectStream(proc.stderr, true),
  proc.exited,
])
clearInterval(heartbeat)

// Do not hide the hook's fixed, sanitized annotations in captured stderr.
const traceWarning =
  /^::warning::Nx CI (?:trace upload failed or timed out|tracing has missing or invalid OTLP configuration)\.$/gm
if (tracingEnabled) {
  const warnings = new Set(stderrRaw.match(traceWarning))
  for (const warning of warnings) console.error(warning)
}

const exitCode = rawExitCode ?? 1
if (exitCode === 0) {
  rmSync(diagnosticsDirectory, { recursive: true, force: true })
  console.log("completed successfully")
  process.exit(0)
}

writeFileSync(join(diagnosticsDirectory, "stdout.log"), stdoutRaw)
writeFileSync(join(diagnosticsDirectory, "stderr.log"), stderrRaw)

const failures = new Map<string, string | null>()
// Summary parsing is a fallback for a missing hook (e.g. an Nx startup error).
// Normalize before matching: Nx colors both the heading and the list markers.
for (const raw of [stdoutRaw, stderrRaw]) {
  const plain = stripVTControlCharacters(raw)
  for (const match of plain.matchAll(
    /Failed tasks:\s*((?:\s*-\s*[^\n]+\n?)+)/g,
  )) {
    for (const line of (match[1] ?? "").split("\n")) {
      const id = line.match(/^\s*-\s*(\S+:\S+)\s*$/)?.[1]
      if (id) failures.set(id, null)
    }
  }
}

try {
  const results: unknown = JSON.parse(
    readFileSync(join(diagnosticsDirectory, "failures.json"), "utf8"),
  )
  if (Array.isArray(results)) {
    const reported = new Map<string, string | null>()
    for (const result of results) {
      if (
        typeof result === "object" &&
        result !== null &&
        "id" in result &&
        typeof result.id === "string" &&
        "output" in result &&
        (typeof result.output === "string" || result.output === null)
      ) {
        reported.set(result.id, result.output)
      } else {
        throw new Error("Invalid Nx task result")
      }
    }
    // The hook is authoritative; summaries can also occur inside task output.
    failures.clear()
    for (const [id, output] of reported) failures.set(id, output)
  }
} catch {
  // The summary still identifies tasks if Nx could not run its completion hook.
}

const bounded = (raw: string, limit: number): string => {
  const text = stripVTControlCharacters(raw)
  if (text.length <= limit) return text
  return `${text.slice(0, limit / 2)}\n... [truncated; full diagnostics below] ...\n${text.slice(-limit / 2)}`
}

for (const [id, output] of failures) {
  console.log(`\n> ${id}\n`)
  console.log(
    output === null
      ? "Task output unavailable: Nx did not supply exact task diagnostics."
      : output.length === 0
        ? "Nx supplied no terminal output."
        : bounded(output, 32_768),
  )
}
if (
  failures.size === 0 ||
  [...failures.values()].some((output) => output === null)
) {
  console.error(
    "Exact failed-task diagnostics unavailable. Bounded Nx stdout/stderr excerpts follow (may include other tasks):",
  )
  console.log(bounded(stdoutRaw, 4_096))
  const stderrExcerpt = tracingEnabled
    ? stderrRaw.replace(traceWarning, "")
    : stderrRaw
  console.error(bounded(stderrExcerpt, 4_096))
  console.error("Re-run with NX_QUIET_INHERIT=1 for live diagnostics.")
}
console.error(
  `Full diagnostics retained in ${diagnosticsDirectory} (failures.json, stdout.log, stderr.log when available).`,
)

process.exit(exitCode)
