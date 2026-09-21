import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { dirname, extname, resolve } from "node:path"
import { Scanner } from "@tailwindcss/oxide"

// Tailwind's automatic scanner skips gitignored build trees, including some
// explicitly registered globs. Feed the same per-stylesheet sources as content
// to its own scanner, then use the supported inline-source directive. Preserve
// the separate public/protected source lists and organisation plugin styles.
export const prepareDashboardStyles = (root: string): void => {
  const files: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith(".css")) files.push(path)
    }
  }
  walk(root)
  for (const stylesheet of files) {
    const content = readFileSync(stylesheet, "utf8")
    const prepared = content.replace(
      /@source\s+["']([^"']+)["'];/g,
      (_directive, pattern: string) => {
        const source = resolve(dirname(stylesheet), pattern)
        const paths =
          existsSync(source) && statSync(source).isFile()
            ? [source]
            : [
                ...new Bun.Glob(
                  existsSync(source) ? `${source}/**/*` : source,
                ).scanSync({ onlyFiles: true, dot: true }),
              ]
        const candidates = new Scanner({}).scanFiles(
          paths.map((path) => ({
            content: readFileSync(path, "utf8"),
            extension: extname(path).slice(1),
          })),
        )
        return `@source inline(${JSON.stringify(candidates.join(" "))});`
      },
    )
    writeFileSync(stylesheet, prepared)
  }
}
