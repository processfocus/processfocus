import { spawn } from "node:child_process"
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"

const inputUrl = process.env["PF_INPUT_URL"]
const resultUrl = process.env["PF_RESULT_URL"]
const inputPath = process.env["PF_STEP_INPUT_PATH"] ?? "/pf/input.json"
const outputPath = process.env["PF_STEP_OUTPUT_PATH"] ?? "/pf/output.json"

if (!inputUrl || !resultUrl) {
  console.error("PF_INPUT_URL and PF_RESULT_URL are required")
  process.exit(1)
}

const command = process.argv.slice(2)
if (command.length === 0) {
  console.error("Docker step runner requires a command")
  process.exit(1)
}

const MAX_TAIL = 16_384

const trimTail = (value) =>
  value.length <= MAX_TAIL ? value : value.slice(value.length - MAX_TAIL)

const readUrlToPath = async (url, destination) => {
  await mkdir(dirname(destination), { recursive: true })

  if (url.startsWith("file://")) {
    await copyFile(fileURLToPath(url), destination)
    return
  }

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(
      `Failed to read ${url}: ${response.status} ${response.statusText}`,
    )
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  await writeFile(destination, buffer)
}

const writeBufferToUrl = async (url, content) => {
  if (url.startsWith("file://")) {
    const destination = fileURLToPath(url)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, content)
    return
  }

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
    },
    body: new Uint8Array(content),
  })

  if (!response.ok) {
    throw new Error(
      `Failed to write ${url}: ${response.status} ${response.statusText}`,
    )
  }
}

await readUrlToPath(inputUrl, inputPath)

const child = spawn(command[0], command.slice(1), {
  env: {
    ...process.env,
    PF_STEP_INPUT_PATH: inputPath,
    PF_STEP_OUTPUT_PATH: outputPath,
  },
  stdio: ["ignore", "pipe", "pipe"],
})

let stdout = ""
let stderr = ""

child.stdout?.on("data", (chunk) => {
  const text = chunk.toString()
  process.stdout.write(text)
  stdout = trimTail(stdout + text)
})

child.stderr?.on("data", (chunk) => {
  const text = chunk.toString()
  process.stderr.write(text)
  stderr = trimTail(stderr + text)
})

const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject)
  child.once("close", (code) => resolve(code ?? 1))
})

let result
if (exitCode === 0) {
  try {
    const outputText = await readFile(outputPath, "utf8")
    result = {
      status: "success",
      output: JSON.parse(outputText),
      error: null,
      exitCode,
      stdoutTail: stdout,
      stderrTail: stderr,
      finishedAt: new Date().toISOString(),
    }
  } catch (error) {
    result = {
      status: "failure",
      output: null,
      error:
        error instanceof Error
          ? `Failed to read PF_STEP_OUTPUT_PATH: ${error.message}`
          : `Failed to read PF_STEP_OUTPUT_PATH: ${String(error)}`,
      exitCode,
      stdoutTail: stdout,
      stderrTail: stderr,
      finishedAt: new Date().toISOString(),
    }
  }
} else {
  result = {
    status: "failure",
    output: null,
    error: `Command exited with code ${exitCode}`,
    exitCode,
    stdoutTail: stdout,
    stderrTail: stderr,
    finishedAt: new Date().toISOString(),
  }
}

await writeBufferToUrl(
  resultUrl,
  Buffer.from(JSON.stringify(result, null, 2), "utf8"),
)

process.exit(exitCode)
