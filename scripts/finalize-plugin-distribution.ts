import { readFile, readdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

const dist = resolve(process.argv[2] ?? "dist")

const PACKAGE_REWRITES: ReadonlyArray<readonly [string, string]> = [
  ["@pf/process/organisation-frontend-plugin-manifest", "processfocus/plugin"],
  ["@pf/frontend-plugin-host", "processfocus/plugin"],
  ["@pf/document-store-service", "@processfocus/runtime"],
  ["@pf/job-handler", "@processfocus/runtime"],
  ["@pf/form-schema", "processfocus/forms"],
  ["@pf/frontend-manifest", "processfocus/manifest"],
  ["@pf/process", "processfocus"],
]

const rewriteSpecifier = (specifier: string): string => {
  for (const [from, to] of PACKAGE_REWRITES) {
    if (specifier === from || specifier.startsWith(`${from}/`)) {
      return specifier === from ? to : `${to}${specifier.slice(from.length)}`
    }
  }
  return specifier
}

const rewriteContents = (content: string): string =>
  content
    .replaceAll(
      /((?:export\s+[^;]*?\sfrom|from|import)\s*\(?\s*)(["'])(@pf\/[^"']+)\2/g,
      (_match, prefix: string, quote: string, specifier: string) =>
        `${prefix}${quote}${rewriteSpecifier(specifier)}${quote}`,
    )
    .replaceAll(
      /(["'])(\.{1,2}\/[^"'?]+)\1/g,
      (match: string, quote: string, specifier: string) =>
        /\.[a-z0-9]+$/i.test(specifier)
          ? match
          : `${quote}${specifier}.js${quote}`,
    )

const rewriteDirectory = async (directory: string): Promise<void> => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      await rewriteDirectory(path)
      continue
    }
    if (!/\.(?:d\.[cm]?ts|[cm]?js)$/.test(entry.name)) continue
    const content = await readFile(path, "utf8")
    const next = rewriteContents(content)
    if (next !== content) await writeFile(path, next)
  }
}

await rewriteDirectory(dist)
