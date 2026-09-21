import { createHash } from "node:crypto"
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Schema } from "effect"
import { prepareDashboardStyles } from "./dashboard-styles"

const SourceManifest = Schema.Struct({
  format: Schema.Literal(1),
  sha256: Schema.String,
  dependencies: Schema.Record({ key: Schema.String, value: Schema.String }),
})
const BuildManifest = Schema.Struct({
  format: Schema.Literal(1),
  source: Schema.String,
  lock: Schema.String,
  org: Schema.String,
  organisationInputs: Schema.String,
  auth: Schema.String,
  graphql: Schema.String,
  dashboard: Schema.String,
})
export const dashboardDirectory = (root: string): string =>
  resolve(root, ".processfocus/dashboard/apps/frontend")
const distribution = (): string => dirname(fileURLToPath(import.meta.url))
const sourceManifest = () =>
  Schema.decodeUnknownSync(SourceManifest)(
    JSON.parse(
      readFileSync(resolve(distribution(), "dashboard-source.json"), "utf8"),
    ),
  )
const LoginMetadata = Schema.Struct({
  providers_supported: Schema.optional(Schema.Array(Schema.String)),
  passkey_open_registration: Schema.optional(Schema.Boolean),
})

export const dashboardOrganisationInputs = async ({
  orgPath,
  authUrl,
}: {
  readonly orgPath: string
  readonly authUrl: string
}): Promise<string> => {
  const hash = createHash("sha256")
  const dist = resolve(orgPath, "dist")
  const addFile = (path: string): void => {
    hash.update(
      JSON.stringify([
        relative(dist, path),
        createHash("sha256").update(readFileSync(path)).digest("hex"),
      ]),
    )
  }
  const addDirectory = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) addDirectory(path)
      else addFile(path)
    }
  }
  // Hash only frontend inputs: backend/model edits can still use import watch.
  for (const file of ["frontend-manifest.json", "browser-plugins.json"])
    addFile(resolve(dist, file))
  for (const directory of [
    "browser-plugins",
    "docs",
    "_pf/app-icons",
    "_pf/public-form-branding",
  ]) {
    const path = resolve(dist, directory)
    if (existsSync(path)) addDirectory(path)
  }
  // Login provider choices are prerendered from the live issuer, not a manifest.
  const response = await fetch(
    new URL("/.well-known/oauth-authorization-server", authUrl),
    { signal: AbortSignal.timeout(2000) },
  )
  if (!response.ok) throw new Error("Could not read Dashboard login metadata")
  const metadata = Schema.decodeUnknownSync(LoginMetadata)(
    await response.json(),
  )
  const providers = metadata.providers_supported ?? []
  hash.update(
    JSON.stringify({
      providers,
      passkeyOpenRegistration:
        providers.includes("passkey") &&
        metadata.passkey_open_registration === true,
    }),
  )
  return hash.digest("hex")
}

const buildIdentity = async (env: NodeJS.ProcessEnv) => {
  const root = env["PF_RUNTIME_ROOT"] ?? process.cwd()
  const hash = createHash("sha256")
  for (const name of [
    "package.json",
    "bun.lock",
    "bun.lockb",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
  ]) {
    const path = resolve(root, name)
    if (existsSync(path)) hash.update(name).update(readFileSync(path))
  }
  return {
    format: 1 as const,
    source: sourceManifest().sha256,
    lock: hash.digest("hex"),
    org: env["PF_ORG"] ?? "",
    organisationInputs: await dashboardOrganisationInputs({
      orgPath: env["PF_ORG"] ?? root,
      authUrl: env["OAUTH_ISSUER_URL"] ?? "",
    }),
    auth: env["OAUTH_ISSUER_URL"] ?? "",
    graphql: env["GRAPHQL_ENDPOINT"] ?? "",
    dashboard: env["FRONTEND_BASE_URL"] ?? "",
  }
}
export const assertDashboardBuild = async (
  env: NodeJS.ProcessEnv,
): Promise<void> => {
  const directory = dashboardDirectory(env["PF_RUNTIME_ROOT"] ?? process.cwd())
  const guidance =
    "Run pf-runtime-local --build --org <organisation> with the same ports before starting."
  try {
    const built = Schema.decodeUnknownSync(BuildManifest)(
      JSON.parse(readFileSync(resolve(directory, "build.json"), "utf8")),
    )
    if (
      !existsSync(resolve(directory, ".next/BUILD_ID")) ||
      JSON.stringify(built) !== JSON.stringify(await buildIdentity(env))
    )
      throw new Error("incompatible")
  } catch {
    throw new Error(
      `Dashboard build is missing or incompatible with this runtime, project dependencies, organisation, or ports. ${guidance}`,
    )
  }
}

export const dashboardEnvironment = (
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv => ({
  ...env,
  NODE_ENV: "production",
  PF_DASHBOARD_SOURCE_ROOT: resolve(
    env["PF_RUNTIME_ROOT"] ?? process.cwd(),
    ".processfocus/dashboard",
  ),
  PF_DASHBOARD_PROJECT_BUILD: "1",
})

export const prepareDashboardBuild = (env: NodeJS.ProcessEnv): string => {
  const root = env["PF_RUNTIME_ROOT"] ?? process.cwd()
  const output = resolve(root, ".processfocus")
  mkdirSync(output, { recursive: true, mode: 0o700 })
  writeFileSync(resolve(output, ".gitignore"), "*\n")
  const stage = resolve(output, "dashboard")
  rmSync(stage, { recursive: true, force: true })
  cpSync(resolve(distribution(), "dashboard-source"), stage, {
    recursive: true,
  })
  // Resolve through the installed runtime package, including nested npm/Bun
  // dependencies. All links remain inside the consumer's installation.
  for (const name of Object.keys(sourceManifest().dependencies)) {
    let resolved: string
    try {
      resolved = Bun.resolveSync(`${name}/package.json`, distribution())
    } catch {
      resolved = Bun.resolveSync(name, distribution())
    }
    let packageRoot = dirname(resolved)
    while (
      !existsSync(resolve(packageRoot, "package.json")) ||
      JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"))
        .name !== name
    ) {
      const parent = dirname(packageRoot)
      if (parent === packageRoot)
        throw new Error(`Cannot locate installed Dashboard dependency ${name}`)
      packageRoot = parent
    }
    const target = resolve(stage, "node_modules", name)
    mkdirSync(dirname(target), { recursive: true })
    symlinkSync(packageRoot, target, "dir")
  }
  const app = dashboardDirectory(root)
  const orgDist = resolve(env["PF_ORG"] ?? root, "dist")
  for (const [source, target] of [
    ["frontend-manifest.json", "lib/generated/frontend-manifest.json"],
    ["docs", "lib/generated/docs"],
    ["_pf/app-icons", "public/_pf/app-icons"],
    ["_pf/public-form-branding", "public/_pf/public-form-branding"],
  ] as const) {
    if (existsSync(resolve(orgDist, source))) {
      mkdirSync(dirname(resolve(app, target)), { recursive: true })
      cpSync(resolve(orgDist, source), resolve(app, target), {
        recursive: true,
      })
    }
  }
  const prepared = Bun.spawnSync(
    [
      process.execPath,
      resolve(distribution(), "prepare-dashboard.mjs"),
      resolve(orgDist, "frontend-manifest.json"),
      resolve(app, "lib/generated/organisation-plugin-loaders.tsx"),
      resolve(app, "lib/generated/organisation-plugin-preparation.ts"),
      resolve(app, "lib/generated/organisation-plugin-composition.json"),
    ],
    { cwd: root, env, stdout: "inherit", stderr: "inherit" },
  )
  if (prepared.exitCode !== 0)
    throw new Error("Dashboard organisation preparation failed")
  prepareDashboardStyles(stage)
  return app
}
export const recordDashboardBuild = async (
  env: NodeJS.ProcessEnv,
): Promise<void> => {
  writeFileSync(
    resolve(
      dashboardDirectory(env["PF_RUNTIME_ROOT"] ?? process.cwd()),
      "build.json",
    ),
    JSON.stringify(await buildIdentity(env)),
    { mode: 0o600 },
  )
}
export const nextCommand = (): string =>
  Bun.resolveSync("next/dist/bin/next", distribution())
