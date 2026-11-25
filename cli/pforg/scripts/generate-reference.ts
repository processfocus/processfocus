import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { generateWithReport } from "usage-spec-effect"
import { version } from "../package.json"
import { pforgCommand } from "../src/main"

const usage = (...args: string[]): string => {
  const result = Bun.spawnSync(["usage", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) {
    throw new Error(`Usage generation failed: ${result.stderr.toString()}`)
  }
  return result.stdout.toString()
}

export const generateReference = async (directory: string): Promise<void> => {
  if (Bun.which("usage") === null) {
    throw new Error(
      "Usage is not installed; run mise install before building pforg",
    )
  }
  // Keep in sync with mise.toml. Do not silently render with a user's global CLI.
  if (usage("--version").trim() !== "usage 7.1.0") {
    throw new Error(
      "Reference generation requires Usage 7.1.0; run mise install",
    )
  }
  const { kdl, unsupported } = generateWithReport(pforgCommand, { version })
  if (unsupported.length > 0) {
    throw new Error(
      `Unreviewed Usage export constructs:\n${unsupported.join("\n")}`,
    )
  }
  await mkdir(directory, { recursive: true })
  const spec = resolve(directory, "pforg.usage.kdl")
  await writeFile(spec, kdl)
  // Parsing with the pinned Usage CLI validates KDL before rendering it.
  usage("generate", "json", "--file", spec)
  const markdown = usage("generate", "markdown", "--file", spec)
  const notes = await readFile(
    resolve(import.meta.dir, "reference-notes.md"),
    "utf8",
  )
  await writeFile(
    resolve(directory, "command-reference.md"),
    `${notes}\n${markdown}`,
  )
}

if (import.meta.main) {
  await generateReference(resolve(import.meta.dir, "../dist"))
}
