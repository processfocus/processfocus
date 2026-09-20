import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, describe, expect, it } from "bun:test"

const tempPaths: string[] = []

const workspaceRoot = resolve(import.meta.dir, "../../../..")
const runnerPath = join(
  workspaceRoot,
  "plugins/docker/assets/pf-docker-step-runner.mjs",
)

const createTempDir = (prefix: string) => {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  tempPaths.push(directory)
  return directory
}

const writeExecutable = (filePath: string, content: string) => {
  writeFileSync(filePath, content)
  chmodSync(filePath, 0o755)
}

afterEach(() => {
  for (const tempPath of tempPaths) {
    rmSync(tempPath, { recursive: true, force: true })
  }

  tempPaths.length = 0
})

describe("pf-docker-step-runner", () => {
  it("keeps the generic Docker step contract on success", () => {
    const workDir = createTempDir("pf-docker-step-runner-")
    const commandPath = join(workDir, "command.sh")
    const inputPath = join(workDir, "input.json")
    const resultPath = join(workDir, "result.json")

    writeExecutable(
      commandPath,
      `#!/usr/bin/env bash
set -euo pipefail
printf '__PF_DEPLOY_PROGRESS__%s\n' '{"phase":"prepare","message":"Preparing deployment"}'
printf 'visible stdout\n'
printf 'visible stderr\n' >&2
cp "$PF_STEP_INPUT_PATH" "$PF_STEP_OUTPUT_PATH"
`,
    )
    writeFileSync(inputPath, `${JSON.stringify({ deployed: true })}\n`)

    const result = Bun.spawnSync(["node", runnerPath, commandPath], {
      env: {
        ...process.env,
        PF_INPUT_URL: pathToFileURL(inputPath).toString(),
        PF_RESULT_URL: pathToFileURL(resultPath).toString(),
        PF_STEP_INPUT_PATH: join(workDir, "mounted-input.json"),
        PF_STEP_OUTPUT_PATH: join(workDir, "mounted-output.json"),
      },
      stdout: "pipe",
      stderr: "pipe",
    })

    const stdout = Buffer.from(result.stdout).toString()
    const stderr = Buffer.from(result.stderr).toString()
    const envelope = JSON.parse(readFileSync(resultPath, "utf8")) as {
      status: string
      output: unknown
      error: string | null
      exitCode: number
      stdoutTail: string
      stderrTail: string
      finishedAt: string
    }

    expect(result.exitCode).toBe(0)
    expect(stdout).toContain("__PF_DEPLOY_PROGRESS__")
    expect(stdout).toContain("visible stdout")
    expect(stderr).toContain("visible stderr")
    expect(envelope.status).toBe("success")
    expect(envelope.output).toEqual({ deployed: true })
    expect(envelope.error).toBeNull()
    expect(envelope.stdoutTail).toContain("__PF_DEPLOY_PROGRESS__")
    expect(envelope.stderrTail).toContain("visible stderr")
    expect(typeof envelope.finishedAt).toBe("string")
  })

  it("writes a failure envelope when the command exits non-zero", () => {
    const workDir = createTempDir("pf-docker-step-runner-")
    const commandPath = join(workDir, "command.sh")
    const inputPath = join(workDir, "input.json")
    const resultPath = join(workDir, "result.json")

    writeExecutable(
      commandPath,
      `#!/usr/bin/env bash
set -euo pipefail
printf 'command failed\n' >&2
exit 17
`,
    )
    writeFileSync(inputPath, `${JSON.stringify({ deployed: true })}\n`)

    const result = Bun.spawnSync(["node", runnerPath, commandPath], {
      env: {
        ...process.env,
        PF_INPUT_URL: pathToFileURL(inputPath).toString(),
        PF_RESULT_URL: pathToFileURL(resultPath).toString(),
        PF_STEP_INPUT_PATH: join(workDir, "mounted-input.json"),
        PF_STEP_OUTPUT_PATH: join(workDir, "mounted-output.json"),
      },
      stdout: "pipe",
      stderr: "pipe",
    })

    const envelope = JSON.parse(readFileSync(resultPath, "utf8")) as {
      status: string
      output: unknown
      error: string | null
      exitCode: number
      stderrTail: string
      finishedAt: string
    }

    expect(result.exitCode).toBe(17)
    expect(envelope.status).toBe("failure")
    expect(envelope.output).toBeNull()
    expect(envelope.error).toBe("Command exited with code 17")
    expect(envelope.exitCode).toBe(17)
    expect(envelope.stderrTail).toContain("command failed")
    expect(typeof envelope.finishedAt).toBe("string")
  })
})
