import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { parseManifest } from "../tools/public-release/policy"

// Scan tracked bytes, including a PR's merge tree, without printing credentials.
export const hasCredential = (content: string): boolean =>
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content) ||
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/.test(content) ||
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/.test(content) ||
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/.test(content) ||
  /\bnpm_[A-Za-z0-9]{30,}\b/.test(content)

export const checkPublicSource = (): void => {
  const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
  const license = readFileSync("LICENSE.md")
  const failures: string[] = []
  for (const file of files) {
    const content = readFileSync(file, "utf8")
    if (hasCredential(content)) failures.push(`Credential pattern: ${file}`)
    if (file === "package.json" || file.endsWith("/package.json")) {
      const manifest = parseManifest(content)
      if (
        manifest["license"] !== "SEE LICENSE IN LICENSE.md" ||
        !readFileSync(join(dirname(file), "LICENSE.md")).equals(license)
      )
        failures.push(`Canonical license mismatch: ${file}`)
    }
  }
  if (failures.length) throw new Error(failures.join("\n"))
  console.info(
    `Checked credentials and package licenses in ${files.length} tracked files`,
  )
}

if (import.meta.main) checkPublicSource()
