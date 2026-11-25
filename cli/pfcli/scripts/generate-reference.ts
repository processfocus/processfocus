import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { generateWithReport } from "usage-spec-effect"
import { pfcliCommand } from "../src/main"
import { CLI_PACKAGE_VERSION as version } from "../src/package-metadata"

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
      "Usage is not installed; run mise install before building pfcli",
    )
  }
  // Keep in sync with mise.toml; do not silently use another global version.
  if (usage("--version").trim() !== "usage 7.1.0") {
    throw new Error(
      "Reference generation requires Usage 7.1.0; run mise install",
    )
  }
  const { kdl, unsupported } = generateWithReport(pfcliCommand, { version })
  // The real tree currently reports nothing. Silent losses are documented in
  // reference-notes.md and checked against Effect's public help in reference.spec.
  if (unsupported.length > 0) {
    throw new Error(
      `Unreviewed Usage export constructs:\n${unsupported.join("\n")}`,
    )
  }
  await mkdir(directory, { recursive: true })
  const spec = resolve(directory, "pfcli.usage.kdl")
  await writeFile(spec, kdl)
  // Validate the KDL with pinned Usage before rendering; JSON itself is not shipped.
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
