import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"
import { PUBLIC_SOURCE_PROJECT_ROOTS } from "../tools/project-boundaries/policy"
import { releaseConfiguration } from "../tools/public-release/policy"

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const parse = (path: string, text: string): Record<string, unknown> => {
  const result = ts.parseConfigFileTextToJson(path, text)
  const value: unknown = result.config
  if (result.error || !object(value))
    throw new Error(`Invalid JSON object: ${path}`)
  return value
}

const privateReference = (value: string): boolean =>
  /(?:^|[! /"\s])(?:cloud\/|infra\/|runtime\/aws(?:\/|$)|examples\/(?:school|tbsnz)(?:\/|$)|fixtures\/private-consumer(?:\/|$)|\.agents\/|\.claude\/|\.opencode\/|skills\/|apps\/www\/cdk)/.test(
    value,
  )

// Used only for configuration: remove private paths, preserving public settings.
const publicConfiguration = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value
      .filter((item) => !(typeof item === "string" && privateReference(item)))
      .map(publicConfiguration)
  }
  if (!object(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key, item]) =>
          !privateReference(key) &&
          !(typeof item === "string" && privateReference(item)),
      )
      .map(([key, item]) => [key, publicConfiguration(item)]),
  )
}

export type WorkspaceEdit = {
  path: string
  before: Buffer | null
  after: Buffer
}

/** Changes only the exported directory. Every rewritten byte is receipted. */
export const preparePublicSourceWorkspace = (
  directory: string,
): WorkspaceEdit[] => {
  const edits: WorkspaceEdit[] = []
  const read = (path: string): Record<string, unknown> =>
    parse(path, readFileSync(join(directory, path), "utf8"))
  const write = (path: string, content: string): void => {
    const file = join(directory, path)
    const before = existsSync(file) ? readFileSync(file) : null
    const after = Buffer.from(content)
    if (before?.equals(after)) return
    writeFileSync(file, after)
    edits.push({ path, before, after })
  }
  const json = (path: string, value: unknown): void => {
    const content = `${JSON.stringify(value, null, 2)}\n`
    write(
      path,
      path.endsWith(".json")
        ? execFileSync(
            join(import.meta.dir, "../node_modules/.bin/biome"),
            ["format", `--stdin-file-path=${path}`],
            { input: content, encoding: "utf8" },
          )
        : content,
    )
  }
  const roots = PUBLIC_SOURCE_PROJECT_ROOTS.filter(
    (root) =>
      !root.startsWith("fixtures/") &&
      existsSync(join(directory, root, "package.json")),
  )
  const manifest = read("package.json")
  manifest["name"] = "@processfocus/source"
  manifest["workspaces"] = roots
  manifest["scripts"] = {
    lint: "biome check --error-on-warnings .",
    "lint:project-boundaries": "bun scripts/check-project-boundaries.ts",
    "snapshot:public-source": "bun scripts/create-public-source-snapshot.ts",
  }
  const devDependencies = manifest["devDependencies"]
  if (object(devDependencies)) {
    for (const name of [
      "@berenddeboer/nx-aws-cdk",
      "aws-cdk",
      "@commitlint/cli",
      "@commitlint/config-conventional",
      "lint-staged",
    ])
      delete devDependencies[name]
  }
  json("package.json", manifest)
  const rootTsconfig = read("tsconfig.json")
  rootTsconfig["references"] = PUBLIC_SOURCE_PROJECT_ROOTS.filter((root) =>
    existsSync(join(directory, root, "tsconfig.json")),
  ).map((root) => ({ path: `./${root}` }))
  json("tsconfig.json", rootTsconfig)
  const nx = read("nx.json")
  nx["release"] = releaseConfiguration
  if (Array.isArray(nx["plugins"]))
    nx["plugins"] = nx["plugins"].filter(
      (plugin) =>
        !(
          object(plugin) &&
          (plugin["plugin"] === "@berenddeboer/nx-aws-cdk/plugin" ||
            (JSON.stringify(plugin["include"]) ?? "").includes(
              "examples/school",
            ))
        ),
    )
  const namedInputs = nx["namedInputs"]
  if (object(namedInputs))
    namedInputs["sharedGlobals"] = [
      "{workspaceRoot}/package.json",
      "{workspaceRoot}/bun.lock",
      "{workspaceRoot}/nx.json",
    ]
  json("nx.json", nx)
  const knip = publicConfiguration(read("knip.json"))
  if (
    object(knip) &&
    object(knip["workspaces"]) &&
    object(knip["workspaces"]["apps/www"])
  )
    knip["workspaces"]["apps/www"]["entry"] = [
      "src/pages/**/*.astro",
      "astro.config.mjs",
    ]
  json("knip.json", knip)
  json("biome.json", publicConfiguration(read("biome.json")))
  const website = read("apps/www/project.json")
  if (object(website["targets"])) delete website["targets"]["deploy"]
  json("apps/www/project.json", website)
  const websitePackage = read("apps/www/package.json")
  if (object(websitePackage["dependencies"])) {
    delete websitePackage["dependencies"]["aws-cdk-lib"]
    delete websitePackage["dependencies"]["constructs"]
  }
  json("apps/www/package.json", websitePackage)
  // Only the excluded private delegation-management test uses this adapter.
  const sqliteOperations = read("packages/sqlite-operations/package.json")
  if (object(sqliteOperations["devDependencies"]))
    delete sqliteOperations["devDependencies"]["@pf/layer-sqlite-bun"]
  json("packages/sqlite-operations/package.json", sqliteOperations)
  const sqliteTsconfigPath = "packages/sqlite-operations/tsconfig.lib.json"
  const sqliteTsconfig = read(sqliteTsconfigPath)
  if (Array.isArray(sqliteTsconfig["references"]))
    sqliteTsconfig["references"] = sqliteTsconfig["references"].filter(
      (reference) =>
        !(
          object(reference) &&
          reference["path"] === "../layer-sqlite-bun/tsconfig.lib.json"
        ),
    )
  json(sqliteTsconfigPath, sqliteTsconfig)
  const runtime = read("runtime/local/project.json")
  if (
    object(runtime["targets"]) &&
    object(runtime["targets"]["dashboard-build"]) &&
    object(runtime["targets"]["dashboard-build"]["options"])
  ) {
    runtime["targets"]["dashboard-build"]["options"]["command"] =
      "NODE_ENV=production DASHBOARD_DISTRIBUTION=generic bash scripts/build-public-dashboard.sh"
  }
  json("runtime/local/project.json", runtime)
  const graphqlSteps = "apps/graphql-e2e/steps/index.ts"
  write(
    graphqlSteps,
    readFileSync(join(directory, graphqlSteps), "utf8").replace(
      'export * from "./cloud-org.steps"\n',
      "",
    ),
  )
  const lock = read("bun.lock")
  if (!object(lock["workspaces"]) || !object(lock["packages"]))
    throw new Error("Unsupported Bun lockfile structure")
  for (const root of Object.keys(lock["workspaces"])) {
    if (root && !roots.some((allowed) => allowed === root))
      delete lock["workspaces"][root]
  }
  for (const root of ["", ...roots]) {
    const packageManifest = root ? read(`${root}/package.json`) : manifest
    const locked = lock["workspaces"][root]
    if (!object(locked))
      throw new Error(`Missing locked public workspace: ${root}`)
    for (const key of [
      "name",
      "version",
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      if (key in packageManifest) locked[key] = packageManifest[key]
      else delete locked[key]
    }
  }
  for (const [name, entry] of Object.entries(lock["packages"])) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") continue
    const workspace = entry[0].split("@workspace:")[1]
    if (workspace && !roots.some((root) => root === workspace))
      delete lock["packages"][name]
  }
  json("bun.lock", lock)
  write(
    "mise.toml",
    readFileSync(join(directory, "mise.toml"), "utf8").replace(
      /^hk = .*\n/m,
      "",
    ),
  )
  json("public-source.json", { schemaVersion: 1, projects: roots })
  write(
    "README.md",
    `# Process Focus\n\nSource-available tools for modelling and executing business processes. See\n[LICENSE.md](LICENSE.md) for the O'Saasy license.\n\n## Development\n\nInstall the Bun and Node versions in mise.toml, then run:\n\n\`\`\`sh\nbun install --frozen-lockfile\nbun run lint\nbun run lint:project-boundaries\nbun scripts/nx-quiet.ts run @pf/demo:build\n\`\`\`\n\nThe examples are examples/demo and examples/on-boarding. Set MY_EMAIL for\nyour own invitation when using the on-boarding example. Hosted CLI commands\ncommunicate with the hosting API; the hosted service implementation is separate.\n\nTo build the generic Dashboard with a temporary local backend:\n\n\`\`\`sh\nbun scripts/nx-quiet.ts run @processfocus/runtime-local:dashboard-build\n\`\`\`\n\nThe Dashboard build requires Linux, Git, curl, flock, and setsid. It supervises\nits own temporary database and local servers.\n`,
  )
  write(
    "CONTEXT-MAP.md",
    "# Context map\n\nThis source workspace owns process authoring, generic execution, authentication,\nforms, the Dashboard, local runtime, CLI, and official plugins. The demo and\non-boarding organisations demonstrate authoring. See each project's README\nand the documentation site in apps/www/src/content/docs/.\n",
  )
  return edits
}
