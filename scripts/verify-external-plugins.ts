import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const pluginName = process.argv[2]
if (!pluginName) throw new Error("Plugin package name is required")

const FIXTURES: Record<
  string,
  {
    readonly fixture: string
    readonly runtime?: boolean
  }
> = {
  "@processfocus/plugin-aws-lambda": {
    fixture: "fixtures/external-plugins/aws-lambda",
  },
  "@processfocus/plugin-docker": {
    fixture: "fixtures/external-plugins/docker",
  },
  "@processfocus/plugin-google-drive": {
    fixture: "fixtures/external-plugins/google-drive",
    runtime: true,
  },
  "@processfocus/plugin-posthog": {
    fixture: "fixtures/external-plugins/posthog",
    runtime: true,
  },
  "@processfocus/plugin-resend": {
    fixture: "fixtures/external-plugins/resend",
    runtime: true,
  },
  "@processfocus/plugin-xero": {
    fixture: "fixtures/external-plugins/xero",
  },
}

const config = FIXTURES[pluginName]
if (!config) throw new Error(`No fixture configured for ${pluginName}`)

const packageVersion = async (packageRoot: string): Promise<string> => {
  const manifest = JSON.parse(
    await readFile(resolve(packageRoot, "package.json"), "utf8"),
  ) as { version: string }
  return manifest.version
}

const pluginFilePrefix = pluginName.replace("@", "").replace("/", "-")
const pluginVersion = await packageVersion(
  {
    "@processfocus/plugin-aws-lambda": "plugins/aws",
    "@processfocus/plugin-docker": "plugins/docker",
    "@processfocus/plugin-google-drive": "plugins/google-drive",
    "@processfocus/plugin-posthog": "plugins/posthog",
    "@processfocus/plugin-resend": "plugins/resend",
    "@processfocus/plugin-xero": "plugins/xero",
  }[pluginName] ?? "",
)
const sdkVersion = await packageVersion("packages/sdk")
const runtimeVersion = await packageVersion("packages/runtime")

const directory = await mkdtemp(join(tmpdir(), "processfocus-plugin-"))
await cp(resolve(config.fixture), directory, { recursive: true })

const tsconfigPath = join(directory, "tsconfig.json")
const tsconfig = JSON.parse(await readFile(tsconfigPath, "utf8")) as {
  references?: unknown
}
delete tsconfig.references
await writeFile(tsconfigPath, `${JSON.stringify(tsconfig, null, 2)}\n`)

const tarballs: Record<string, string> = {
  processfocus: resolve(
    `dist/packages/processfocus/processfocus-${sdkVersion}.tgz`,
  ),
  "@processfocus/runtime": resolve(
    `dist/packages/processfocus-runtime/processfocus-runtime-${runtimeVersion}.tgz`,
  ),
  [pluginName]: resolve(
    `dist/packages/${pluginFilePrefix}/${pluginFilePrefix}-${pluginVersion}.tgz`,
  ),
}

const packageJsonPath = join(directory, "package.json")
const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
  dependencies: Record<string, string>
  overrides?: Record<string, string>
}
packageJson.dependencies["processfocus"] = tarballs.processfocus
packageJson.dependencies[pluginName] = tarballs[pluginName] ?? ""
packageJson.overrides = {
  processfocus: tarballs.processfocus,
  "@processfocus/runtime": tarballs["@processfocus/runtime"] ?? "",
}
if (config.runtime) {
  packageJson.dependencies["@processfocus/runtime"] =
    tarballs["@processfocus/runtime"] ?? ""
}
await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`)

const run = (command: string[]) => {
  const result = Bun.spawnSync(command, {
    cwd: directory,
    stdout: "inherit",
    stderr: "inherit",
  })
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")} failed`)
}

run(["bun", "install", "--ignore-scripts"])
run(["bun", "run", "typecheck"])
run(["bun", "run", "exercise"])
