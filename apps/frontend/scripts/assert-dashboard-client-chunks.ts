import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"

export const FORBIDDEN_DASHBOARD_CLIENT_CHUNK_PATTERNS = [
  { id: "aws-sdk", pattern: /@aws-sdk\// },
  { id: "aws-cdk", pattern: /aws-cdk(?:-lib)?(?:\/|"|'|`|$)/ },
  { id: "drizzle", pattern: /drizzle-orm/ },
  { id: "job-worker", pattern: /job-worker/ },
  {
    id: "cloud-backend",
    pattern: /cloud\/org\/src\/(?:docker|schema|lambdas)\//,
  },
] as const

export interface ForbiddenClientChunkMatch {
  readonly file: string
  readonly id: (typeof FORBIDDEN_DASHBOARD_CLIENT_CHUNK_PATTERNS)[number]["id"]
}

const CLIENT_CHUNK_DIRECTORIES = [
  ".next/static/chunks",
  ".open-next/assets",
] as const

const isJavaScriptFile = (path: string): boolean =>
  path.endsWith(".js") || path.endsWith(".mjs")

const listFiles = (directory: string): string[] => {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...listFiles(path))
      continue
    }
    if (entry.isFile() && isJavaScriptFile(path) && statSync(path).isFile()) {
      files.push(path)
    }
  }
  return files
}

export const findForbiddenDashboardClientChunkMatches = (
  frontendRoot: string,
): readonly ForbiddenClientChunkMatch[] => {
  const matches: ForbiddenClientChunkMatch[] = []
  for (const directory of CLIENT_CHUNK_DIRECTORIES) {
    const root = resolve(frontendRoot, directory)
    try {
      if (!statSync(root).isDirectory()) continue
    } catch {
      continue
    }
    for (const file of listFiles(root)) {
      const source = readFileSync(file, "utf8")
      for (const { id, pattern } of FORBIDDEN_DASHBOARD_CLIENT_CHUNK_PATTERNS) {
        if (pattern.test(source)) {
          matches.push({
            file: relative(frontendRoot, file).split("/").join("/"),
            id,
          })
        }
      }
    }
  }
  return matches
}

if (import.meta.main) {
  const frontendRoot = resolve(process.argv[2] ?? join(import.meta.dir, ".."))
  const matches = findForbiddenDashboardClientChunkMatches(frontendRoot)
  if (matches.length > 0) {
    console.error(
      `Dashboard client chunks include forbidden modules:\n${matches
        .map((match) => `  ${match.file}: ${match.id}`)
        .join("\n")}`,
    )
    process.exitCode = 1
  }
}
