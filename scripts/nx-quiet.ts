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

import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { stripVTControlCharacters } from "node:util"

const args = process.argv.slice(2)

if (args.length === 0) {
  console.error("Usage: bun scripts/nx-quiet.ts <nx-command> [args...]")
  console.error("Example: bun scripts/nx-quiet.ts affected -t lint,test")
  process.exit(1)
}

const startTime = Date.now()

const inheritIo = process.env["NX_QUIET_INHERIT"] === "1"

const isProgressLine = (line: string): boolean => {
  const plain = stripVTControlCharacters(line)
  return (
    /^\s*> nx run /.test(plain) ||
    /^ NX {3}Running target /.test(plain) ||
    /^ NX {3}Successfully ran /.test(plain) ||
    /^ NX {3}Failed tasks:/.test(plain) ||
    /^\s*-\s+\S+:\S+/.test(plain)
  )
}

const collectStream = async (
  stream: ReadableStream<Uint8Array>,
  forwardProgress: boolean,
): Promise<string> => {
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

const nxArgs = ["bun", "nx", "--outputStyle=stream", ...args]
if (!inheritIo && !args.includes("--batch")) nxArgs.push("--batch")

const proc = Bun.spawn(nxArgs, {
  env: {
    ...process.env,
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
  collectStream(proc.stderr, false),
  proc.exited,
])
clearInterval(heartbeat)

const exitCode = rawExitCode ?? 1
const stdoutText = stdoutRaw
  .split("\n")
  .filter(
    (line) =>
      !line.includes(
        'Your AI agent configuration is outdated. Run "nx configure-ai-agents" to update.',
      ),
  )
  .join("\n")
const stderrText = stderrRaw

if (exitCode === 0) {
  console.log("completed successfully")
  process.exit(0)
}

const failedTasksMatch = stdoutText.match(
  /Failed tasks:\s*((?:\s*-\s*.+\n?)+)/m,
)
const failedTasks: string[] = []

if (failedTasksMatch) {
  const taskLines = failedTasksMatch[1].trim().split("\n")
  for (const line of taskLines) {
    const taskMatch = line.match(/^\s*-\s*(.+)$/)
    if (taskMatch) {
      failedTasks.push(taskMatch[1].trim())
    }
  }
}

const terminalOutputsDir = ".nx/cache/terminalOutputs"
let terminalOutputFiles: string[] = []

try {
  const files = readdirSync(terminalOutputsDir)
  terminalOutputFiles = files.filter((file) => {
    const filePath = join(terminalOutputsDir, file)
    const stats = statSync(filePath)
    return stats.mtimeMs >= startTime - 1000
  })
} catch (_error) {
  // .nx/cache/terminalOutputs might not exist
}

if (failedTasks.length > 0 && terminalOutputFiles.length > 0) {
  console.log("\n NX   Failed tasks:\n")

  for (const task of failedTasks) {
    console.log(`\n> ${task}\n`)

    for (const file of terminalOutputFiles) {
      const filePath = join(terminalOutputsDir, file)
      const output = readFileSync(filePath, "utf-8")
      console.log(output)
    }
  }
} else {
  if (stdoutText.trim()) {
    console.log(stdoutText)
  }
  if (stderrText.trim()) {
    console.error(stderrText)
  }
}

process.exit(exitCode)
