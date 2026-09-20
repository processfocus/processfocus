import {
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, resolve } from "node:path"
import {
  normalizeNextDynamicRouteParameterTokens,
  normalizeNextMetadata,
} from "../src/distribution/deterministic-next-artifacts"

const projectRoot = resolve(import.meta.dir, "..")
const workspaceRoot = resolve(projectRoot, "../..")
const dist = resolve(projectRoot, "dist")
// Assemble the published package from the independently cacheable runtime bundle.
rmSync(dist, { force: true, recursive: true })
cpSync(resolve(projectRoot, "out-tsc/runtime"), dist, { recursive: true })

const standaloneRoot = resolve(workspaceRoot, "apps/frontend/.next/standalone")
const standaloneApp = resolve(standaloneRoot, "apps/frontend")
if (!existsSync(resolve(standaloneApp, "server.js"))) {
  throw new Error(
    "Dashboard standalone output is missing; build @pf/frontend:next-build before packaging runtime-local",
  )
}

const dashboard = resolve(dist, "dashboard")
const tracedPackages = resolve(standaloneRoot, "node_modules/.bun/node_modules")
cpSync(
  resolve(standaloneRoot, "node_modules"),
  resolve(dashboard, "node_modules"),
  {
    recursive: true,
    dereference: true,
    filter: (source) => source !== tracedPackages,
  },
)
// Bun's standalone trace keeps its top-level package links in
// node_modules/.bun/node_modules. npm packing intentionally omits symlinks, so
// materialise those packages at the conventional node_modules locations.
for (const name of readdirSync(tracedPackages)) {
  const source = resolve(tracedPackages, name)
  if (!existsSync(source)) continue

  cpSync(source, resolve(dashboard, "node_modules", name), {
    recursive: true,
    dereference: true,
    force: true,
  })
}
// Next has its own traced SWC helper version. It lives beside Next in Bun's
// package store, so preserve that resolution when flattening the trace.
const nextStoreDependencies = dirname(
  realpathSync(resolve(tracedPackages, "next")),
)
const swcHelpers = resolve(dashboard, "node_modules/@swc/helpers")
rmSync(swcHelpers, { force: true, recursive: true })
cpSync(resolve(nextStoreDependencies, "@swc/helpers"), swcHelpers, {
  recursive: true,
  dereference: true,
})
cpSync(
  resolve(standaloneApp, ".next"),
  resolve(dashboard, "apps/frontend/.next"),
  { recursive: true },
)
cpSync(
  resolve(standaloneApp, "server.js"),
  resolve(dashboard, "apps/frontend/server.js"),
)
cpSync(
  resolve(workspaceRoot, "apps/frontend/.next/static"),
  resolve(dashboard, "apps/frontend/.next/static"),
  { recursive: true },
)
cpSync(
  resolve(workspaceRoot, "apps/frontend/public"),
  resolve(dashboard, "apps/frontend/public"),
  { recursive: true },
)
writeFileSync(
  resolve(dashboard, "apps/frontend/package.json"),
  `${JSON.stringify({ private: true, type: "commonjs" }, null, 2)}\n`,
)

const dashboardBuildId = readFileSync(
  resolve(dashboard, "apps/frontend/.next/BUILD_ID"),
  "utf8",
).trim()

const sanitize = (directory: string): void => {
  for (const name of readdirSync(directory)) {
    const filePath = join(directory, name)
    if (statSync(filePath).isDirectory()) {
      sanitize(filePath)
    } else if (name.endsWith(".map")) {
      rmSync(filePath)
    } else if (
      name === "server.js" ||
      name.endsWith(".json") ||
      name.endsWith(".meta") ||
      name.endsWith(".rsc")
    ) {
      const content = readFileSync(filePath, "utf8")
      const withoutWorkspaceRoot = content.replaceAll(workspaceRoot, ".")
      const sanitized = name.endsWith(".meta")
        ? normalizeNextMetadata(withoutWorkspaceRoot, dashboardBuildId)
        : normalizeNextDynamicRouteParameterTokens(
            withoutWorkspaceRoot,
            dashboardBuildId,
          )
      if (sanitized !== content) {
        writeFileSync(filePath, sanitized)
      }
    }
  }
}
sanitize(dashboard)
