import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { resolve } from "node:path"

const projectRoot = resolve(import.meta.dir, "..")
const workspaceRoot = resolve(projectRoot, "../..")
const dist = resolve(projectRoot, "out-tsc/runtime")
const external = [
  "@effect/opentelemetry",
  "@cedar-policy/cedar-wasm",
  "@opentelemetry/exporter-metrics-otlp-http",
  "@opentelemetry/exporter-trace-otlp-http",
  "@opentelemetry/sdk-metrics",
  "@opentelemetry/sdk-trace-base",
  "@tursodatabase/database",
  "@tursodatabase/serverless",
  "@tursodatabase/sync",
  "effect",
]

rmSync(dist, { force: true, recursive: true })
mkdirSync(dist, { recursive: true })

const result = await Bun.build({
  entrypoints: [
    resolve(projectRoot, "src/main.ts"),
    resolve(projectRoot, "src/authentication-server/authentication-server.ts"),
    resolve(projectRoot, "src/graphql-server/graphql-server.ts"),
    resolve(projectRoot, "src/job-worker/job-worker.ts"),
  ],
  outdir: dist,
  naming: "[name].mjs",
  target: "bun",
  format: "esm",
  splitting: true,
  minify: false,
  sourcemap: "none",
  external,
})
if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

// Bun's non-minified output includes module-boundary comments with paths back
// into the workspace. They are not needed at runtime and must not disclose the
// repository layout in the published artifact.
for (const name of readdirSync(dist)) {
  if (!name.endsWith(".js") && !name.endsWith(".mjs")) continue
  const filePath = resolve(dist, name)
  const content = readFileSync(filePath, "utf8")
  writeFileSync(filePath, content.replace(/^\/\/ (?:\.\.\/)+.*$/gm, ""))
}

cpSync(
  resolve(workspaceRoot, "packages/auth-policy/cedar"),
  resolve(dist, "resources/cedar"),
  { recursive: true },
)
cpSync(
  resolve(workspaceRoot, "packages/graphql-schema/graphql"),
  resolve(dist, "resources/graphql-schema"),
  { recursive: true },
)
