import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { PRIVATE_SOURCE_PROJECT_ROOTS } from "../tools/project-boundaries/policy"
import { assertDashboardPackageFile } from "./dashboard-package-policy"

const packageName = process.argv[2]
if (!packageName) throw new Error("Package name is required")

const PACKAGE_ROOTS: Record<string, string> = {
  processfocus: "packages/sdk",
  "@processfocus/runtime": "packages/runtime",
  "@processfocus/hosting-contract": "packages/hosting-contract",
  "@processfocus/cli": "cli/pfcli",
  "@processfocus/pforg": "cli/pforg",
  "@processfocus/runtime-local": "runtime/local",
  "@processfocus/plugin-aws-lambda": "plugins/aws",
  "@processfocus/plugin-docker": "plugins/docker",
  "@processfocus/plugin-google-drive": "plugins/google-drive",
  "@processfocus/plugin-posthog": "plugins/posthog",
  "@processfocus/plugin-resend": "plugins/resend",
  "@processfocus/plugin-xero": "plugins/xero",
}

const EXTRA_PACKED_PREFIXES: Record<string, readonly string[]> = {
  "@processfocus/plugin-docker": ["assets/"],
  "@processfocus/plugin-google-drive": ["styles.css"],
}

const unpublishedImplementationImport =
  /(?:from|import|require)\s*\(?\s*["']@pf\//
const PUBLIC_INTERNAL_TAG_PREFIX = "processfocus:internal-tag/"

const PLUGIN_CONTRACT_DEPENDENCIES = {
  processfocus: "0.1.0-next.0",
  "@processfocus/runtime": "0.1.0-next.0",
} as const

const isPluginPackage = (name: string): boolean =>
  name.startsWith("@processfocus/plugin-")
const packageRoot = PACKAGE_ROOTS[packageName]
if (!packageRoot)
  throw new Error(`No package root configured for ${packageName}`)
const packageFilePrefix = packageName.replace("@", "").replace("/", "-")
const inspectedPackageRoot = `dist/package-inspection/${packageName.replace("/", "-")}/package`

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const normalizePublishedImplementationIdentifiers = async (
  directory: string,
): Promise<void> => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      await normalizePublishedImplementationIdentifiers(path)
      continue
    }
    if (!/\.(?:(?:c|m)?js|d\.[cm]?ts)$/.test(path)) continue

    const content = await readFile(path, "utf8")
    if (unpublishedImplementationImport.test(content)) {
      throw new Error(
        `${path} imports an unpublished @pf/* implementation package`,
      )
    }
    if (content.includes("@pf/")) {
      await writeFile(
        path,
        content.replaceAll("@pf/", PUBLIC_INTERNAL_TAG_PREFIX),
      )
    }
  }
}

const projectConfiguration: unknown = JSON.parse(
  await readFile(resolve(packageRoot, "project.json"), "utf8"),
)
if (!isRecord(projectConfiguration)) {
  throw new Error(`${packageRoot}/project.json must contain an object`)
}
const targets = projectConfiguration["targets"]
const publishTarget = isRecord(targets)
  ? targets["nx-release-publish"]
  : undefined
const publishOptions = isRecord(publishTarget)
  ? publishTarget["options"]
  : undefined
if (
  !isRecord(publishTarget) ||
  publishTarget["executor"] !== "@nx/js:release-publish" ||
  !isRecord(publishOptions) ||
  publishOptions["packageRoot"] !== inspectedPackageRoot
) {
  throw new Error(
    `${packageName} must publish the inspected package from ${inspectedPackageRoot}`,
  )
}

const outputDirectory = resolve("dist/packages", packageFilePrefix)
await rm(outputDirectory, { recursive: true, force: true })
await mkdir(outputDirectory, { recursive: true })

type ExportTarget = string | Record<string, string>
type PackageManifest = {
  readonly name: string
  readonly version: string
  private?: boolean
  exports: Record<string, ExportTarget>
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

const manifestPath = resolve(packageRoot, "package.json")
const manifest = JSON.parse(
  await readFile(manifestPath, "utf8"),
) as PackageManifest
const stagingDirectory = await mkdtemp(join(tmpdir(), "processfocus-package-"))

await cp(resolve(packageRoot, "dist"), join(stagingDirectory, "dist"), {
  recursive: true,
})
if (isPluginPackage(packageName)) {
  const finalize = Bun.spawnSync(
    [
      "bun",
      resolve("scripts/finalize-plugin-distribution.ts"),
      join(stagingDirectory, "dist"),
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  if (finalize.exitCode !== 0) {
    throw new Error(finalize.stderr.toString() || finalize.stdout.toString())
  }
}
await normalizePublishedImplementationIdentifiers(
  join(stagingDirectory, "dist"),
)
for (const file of ["README.md", "LICENSE.md"]) {
  await cp(resolve(packageRoot, file), join(stagingDirectory, file))
}
for (const extra of EXTRA_PACKED_PREFIXES[packageName] ?? []) {
  await cp(resolve(packageRoot, extra), join(stagingDirectory, extra), {
    recursive: extra.endsWith("/"),
  })
}

for (const [subpath, target] of Object.entries(manifest.exports)) {
  if (typeof target === "string") continue
  const next = Object.fromEntries(
    Object.entries(target).filter(
      ([, path]) => !/\.tsx?$/.test(path) || /\.d\.[cm]?tsx?$/.test(path),
    ),
  )
  if (Object.keys(next).length === 0) delete manifest.exports[subpath]
  else manifest.exports[subpath] = next
}
if (isPluginPackage(packageName)) {
  delete manifest.private
  const publicDependencies: Record<string, string> = {}
  for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
    if (name.startsWith("@pf/") || version.startsWith("workspace:")) continue
    publicDependencies[name] = version
  }
  const publicPeerDependencies = Object.fromEntries(
    Object.entries(manifest.peerDependencies ?? {}).filter(
      ([name, version]) =>
        !name.startsWith("@pf/") && !version.startsWith("workspace:"),
    ),
  )
  manifest.peerDependencies = {
    ...publicPeerDependencies,
    processfocus: PLUGIN_CONTRACT_DEPENDENCIES.processfocus,
    ...(packageName === "@processfocus/plugin-google-drive" ||
    packageName === "@processfocus/plugin-resend"
      ? {
          "@processfocus/runtime":
            PLUGIN_CONTRACT_DEPENDENCIES["@processfocus/runtime"],
        }
      : {}),
  }
  manifest.dependencies = publicDependencies
} else {
  manifest.dependencies = Object.fromEntries(
    Object.entries(manifest.dependencies ?? {}).map(([name, version]) => [
      name,
      version.startsWith("workspace:") && PACKAGE_ROOTS[name] !== undefined
        ? manifest.version
        : version,
    ]),
  )
}
delete manifest.devDependencies
await writeFile(
  join(stagingDirectory, "package.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
)

const pack = Bun.spawnSync(
  ["bun", "pm", "pack", "--destination", outputDirectory, "--ignore-scripts"],
  { cwd: stagingDirectory, stdout: "pipe", stderr: "pipe" },
)
if (pack.exitCode !== 0) {
  throw new Error(pack.stderr.toString())
}

const tarballName = (await readdir(outputDirectory)).find(
  (file) => file === `${packageFilePrefix}-${manifest.version}.tgz`,
)
if (!tarballName) throw new Error(`No tarball was produced for ${packageName}`)
const tarball = join(outputDirectory, tarballName)
const unpacked = resolve(
  "dist/package-inspection",
  packageName.replace("/", "-"),
)
await rm(unpacked, { recursive: true, force: true })
await mkdir(unpacked, { recursive: true })

const extract = Bun.spawnSync(["tar", "-xzf", tarball, "-C", unpacked], {
  stdout: "pipe",
  stderr: "pipe",
})
if (extract.exitCode !== 0) throw new Error(extract.stderr.toString())

const packageDirectory = join(unpacked, "package")
const files: string[] = []
const walk = async (directory: string): Promise<void> => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await walk(path)
    else files.push(path.slice(packageDirectory.length + 1))
  }
}
await walk(packageDirectory)

for (const required of ["package.json", "README.md", "LICENSE.md"]) {
  if (!files.includes(required)) throw new Error(`${required} is missing`)
}
const extraPrefixes = EXTRA_PACKED_PREFIXES[packageName] ?? []
const unexpected = files.filter(
  (file) =>
    !["package.json", "README.md", "LICENSE.md"].includes(file) &&
    !file.startsWith("dist/") &&
    !extraPrefixes.some((prefix) => file === prefix || file.startsWith(prefix)),
)
if (unexpected.length > 0) {
  throw new Error(`Unexpected packed files: ${unexpected.join(", ")}`)
}

for (const file of files) {
  assertDashboardPackageFile(
    file,
    /\.(?:json|[cm]?[jt]sx?)$/.test(file)
      ? await readFile(join(packageDirectory, file), "utf8")
      : undefined,
  )
}

const forbidden = [
  resolve("."),
  '"sourcesContent":',
  "processfocus/internal/",
  ...PRIVATE_SOURCE_PROJECT_ROOTS,
  "../packages/",
  "../runtime/",
]
const unpublishedImport = /(?:from|import)\s*\(?\s*["']@pf\//
const workspaceDependency = /"[^"]+"\s*:\s*"workspace:/
for (const file of files.filter((path) =>
  /\.(?:json|map|[cm]?[jt]sx?|md|css)$/.test(path),
)) {
  const content = await readFile(join(packageDirectory, file), "utf8")
  if (workspaceDependency.test(content)) {
    throw new Error(`${file} contains a workspace dependency`)
  }
  for (const pattern of forbidden) {
    if (content.includes(pattern)) {
      throw new Error(`${file} contains forbidden reference ${pattern}`)
    }
  }
  if (content.includes('Context.Tag("./')) {
    throw new Error(`${file} rewrote an Effect Tag identifier to a file path`)
  }
  if (file.startsWith("dist/internal/")) {
    throw new Error(`${file} vendors an unpublished host or workspace module`)
  }
  if (file.startsWith("dist/") && content.includes("@pf/")) {
    throw new Error(`${file} contains a private @pf/ implementation identifier`)
  }
  if (unpublishedImport.test(content)) {
    throw new Error(`${file} contains unpublished @pf/ import`)
  }
}

const packedManifest = JSON.parse(
  await readFile(join(packageDirectory, "package.json"), "utf8"),
) as { exports: Record<string, string | Record<string, string>> }
for (const [subpath, target] of Object.entries(packedManifest.exports)) {
  const targets = typeof target === "string" ? [target] : Object.values(target)
  for (const path of targets) {
    if (/\.ts$/.test(path) && !/\.d\.[cm]?ts$/.test(path)) {
      throw new Error(`${subpath} exports TypeScript source ${path}`)
    }
    if (!files.includes(path.replace(/^\.\//, ""))) {
      throw new Error(`${subpath} export target ${path} is missing`)
    }
  }
}

console.log(tarball)
