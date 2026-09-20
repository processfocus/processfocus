import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const projectRoot = resolve(import.meta.dir, "..")
const workspaceRoot = resolve(projectRoot, "../..")
const dist = resolve(projectRoot, "dist")
const external = [
  "@cedar-policy/cedar-wasm",
  "@processfocus/hosting-contract",
  "@processfocus/runtime",
  "@tursodatabase/database",
  "@tursodatabase/serverless",
  "@tursodatabase/sync",
  "effect",
]
const unpublishedImplementationImport = /(?:from|import)\s*\(?\s*["']@pf\//
const PUBLIC_INTERNAL_TAG_PREFIX = "processfocus:internal-tag/"

rmSync(dist, { force: true, recursive: true })
mkdirSync(dist, { recursive: true })

const build = async (entrypoint: string, naming: string) => {
  const result = await Bun.build({
    define: { PFCLI_DISTRIBUTION_BUILD: "true" },
    entrypoints: [resolve(projectRoot, entrypoint)],
    outdir: dist,
    naming,
    target: "bun",
    format: "esm",
    minify: true,
    sourcemap: "none",
    external,
  })

  if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }

  const output = resolve(dist, naming)
  const bundled = readFileSync(output, "utf8")
  if (unpublishedImplementationImport.test(bundled)) {
    throw new Error(`${naming} imports an unpublished @pf/* package`)
  }
  const normalized = bundled.replaceAll("@pf/", PUBLIC_INTERNAL_TAG_PREFIX)
  if (normalized.includes("@pf/")) {
    throw new Error(`${naming} contains a private @pf/* identifier`)
  }
  writeFileSync(output, normalized)
}

await build("src/utils/bundled-db-import.ts", "bundled-db-import.mjs")
await build("src/utils/bundled-graphql-schema.ts", "bundled-graphql-schema.mjs")
await build(
  "src/prepare-deployment-artifact-main.ts",
  "prepare-deployment-artifact.mjs",
)
await build("src/main.ts", "main.mjs")

cpSync(
  resolve(workspaceRoot, "packages/auth-policy/cedar"),
  resolve(dist, "resources/cedar"),
  { recursive: true },
)
cpSync(
  resolve(workspaceRoot, "packages/drizzle-sqlite/drizzle"),
  resolve(dist, "resources/system-migrations"),
  { recursive: true },
)
