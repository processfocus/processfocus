import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const fixture = resolve("fixtures/external-authoring")
const pfcli = resolve("cli/pfcli/src/main.ts")
const directory = await mkdtemp(join(tmpdir(), "processfocus-authoring-"))
await cp(fixture, directory, { recursive: true })

const packageVersion = async (packageRoot: string): Promise<string> => {
  const manifest = JSON.parse(
    await readFile(resolve(packageRoot, "package.json"), "utf8"),
  ) as { version: string }
  return manifest.version
}
const sdkVersion = await packageVersion("packages/sdk")
const runtimeVersion = await packageVersion("packages/runtime")
const awsLambdaVersion = await packageVersion("plugins/aws")
const posthogVersion = await packageVersion("plugins/posthog")
const tarballs = {
  processfocus: resolve(
    `dist/packages/processfocus/processfocus-${sdkVersion}.tgz`,
  ),
  runtime: resolve(
    `dist/packages/processfocus-runtime/processfocus-runtime-${runtimeVersion}.tgz`,
  ),
  awsLambda: resolve(
    `dist/packages/processfocus-plugin-aws-lambda/processfocus-plugin-aws-lambda-${awsLambdaVersion}.tgz`,
  ),
  posthog: resolve(
    `dist/packages/processfocus-plugin-posthog/processfocus-plugin-posthog-${posthogVersion}.tgz`,
  ),
}
const packageJsonPath = join(directory, "package.json")
const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
  dependencies: Record<string, string>
  overrides?: Record<string, string>
}
packageJson.dependencies["processfocus"] = tarballs.processfocus
packageJson.dependencies["@processfocus/runtime"] = tarballs.runtime
packageJson.dependencies["@processfocus/plugin-aws-lambda"] = tarballs.awsLambda
packageJson.dependencies["@processfocus/plugin-posthog"] = tarballs.posthog
packageJson.overrides = {
  processfocus: tarballs.processfocus,
  "@processfocus/runtime": tarballs.runtime,
  "@processfocus/plugin-aws-lambda": tarballs.awsLambda,
  "@processfocus/plugin-posthog": tarballs.posthog,
}
await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`)

const tsconfigPath = join(directory, "tsconfig.json")
const tsconfig = JSON.parse(await readFile(tsconfigPath, "utf8")) as {
  references?: unknown
}
delete tsconfig.references
await writeFile(tsconfigPath, `${JSON.stringify(tsconfig, null, 2)}\n`)

const run = (command: string[]) => {
  const result = Bun.spawnSync(command, {
    cwd: directory,
    stdout: "inherit",
    stderr: "inherit",
  })
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")} failed`)
}

run(["bun", "install", "--ignore-scripts"])
await cp(
  join(directory, "node_modules/processfocus"),
  join(directory, "node_modules/processfocus-copy"),
  { recursive: true },
)
run(["bun", "run", "typecheck"])
run(["bun", "run", "build"])
run(["bun", "run", "validate"])
run(["bun", "run", "cross-copy"])
run(["bun", pfcli, "build", ".", "--output", "pfcli-dist"])
