import { mkdirSync, readFileSync, rmSync } from "node:fs"
import { resolve } from "node:path"

const projectRoot = resolve(import.meta.dir, "..")
const dist = resolve(projectRoot, "dist")
const unpublishedImplementationImport =
  /(?:from|import|require)\s*\(?\s*["']@pf\//

rmSync(dist, { force: true, recursive: true })
mkdirSync(dist, { recursive: true })

const result = await Bun.build({
  entrypoints: [resolve(projectRoot, "src/main.ts")],
  outdir: dist,
  naming: "main.mjs",
  target: "bun",
  format: "esm",
  minify: true,
  sourcemap: "none",
  external: ["effect"],
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

const output = resolve(dist, "main.mjs")
const bundled = readFileSync(output, "utf8")
if (unpublishedImplementationImport.test(bundled)) {
  throw new Error("main.mjs imports an unpublished @pf/* package")
}
