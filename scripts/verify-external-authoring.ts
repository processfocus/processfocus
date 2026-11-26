import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { Result, Schema } from "effect"
import { isForm, isOrganisation } from "../packages/process/src/lib/brands"

const fixture = resolve("fixtures/external-authoring")
const pfcli = resolve("cli/pfcli/src/main.ts")
const directory = await mkdtemp(join(tmpdir(), "processfocus-authoring-"))
try {
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
  packageJson.dependencies["@processfocus/plugin-aws-lambda"] =
    tarballs.awsLambda
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

  run(["bun", "src/exercise-artifact.mjs", "pfcli-dist"])

  // The server schema is interpreted by the host, not the consumer's Effect copy.
  const artifact: unknown = await import(
    pathToFileURL(join(directory, "pfcli-dist/org.js")).href
  )
  if (
    typeof artifact !== "object" ||
    artifact === null ||
    !("org" in artifact) ||
    !isOrganisation(artifact.org)
  )
    throw new Error("Missing packaged organisation")
  const form = artifact.org.node
    .findAll()
    .find((node) => node.node.path === "Operations/Plugin/Submit")
  if (!isForm(form)) throw new Error("Missing packaged plugin form")
  const serverCodec = Schema.make(form.submissionEffectSchema.ast)
  const decoded = Schema.decodeUnknownSync(serverCodec)({
    summary: "  Packaged plugin  ",
  })
  if (
    JSON.stringify(decoded) !== JSON.stringify({ summary: "Packaged plugin" })
  )
    throw new Error("Host failed to decode the packaged server schema")
  if (
    !Result.isFailure(Schema.decodeUnknownResult(serverCodec)({ summary: "x" }))
  )
    throw new Error("Host accepted invalid packaged plugin input")
} finally {
  await rm(directory, { recursive: true, force: true })
}
