import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { NodeServices } from "@effect/platform-node"
import { ConfigProvider, Console, Effect, Schema } from "effect"
import { CliOutput, Command, type HelpDoc } from "effect/cli"
import { generateWithReport } from "usage-spec-effect"
import { generateReference } from "../scripts/generate-reference"
import { pfcliCommand } from "../src/main"
import { CLI_PACKAGE_VERSION as version } from "../src/package-metadata"
import { expect, test } from "bun:test"

const dist = resolve(import.meta.dir, "../dist")
const Parameter = Schema.Struct({
  name: Schema.String,
  required: Schema.optional(Schema.Boolean),
  var: Schema.optional(Schema.Boolean),
  default: Schema.optional(Schema.Array(Schema.String)),
})
const SpecFlag = Schema.Struct({
  ...Parameter.fields,
  short: Schema.Array(Schema.String),
  long: Schema.Array(Schema.String),
  arg: Schema.optional(
    Schema.Struct({
      choices: Schema.optional(
        Schema.Struct({ choices: Schema.Array(Schema.String) }),
      ),
    }),
  ),
})
const SpecCommand = Schema.Struct({
  subcommands: Schema.Record(Schema.String, Schema.Unknown),
  args: Schema.Array(Parameter),
  flags: Schema.Array(SpecFlag),
})
const readSpec = () => {
  const result = Bun.spawnSync([
    "usage",
    "generate",
    "json",
    "--file",
    join(dist, "pfcli.usage.kdl"),
  ])
  expect(result.exitCode).toBe(0)
  return Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Struct({ cmd: SpecCommand })),
  )(result.stdout.toString()).cmd
}
const specAt = (path: readonly string[]) =>
  path.reduce(
    (spec, name) =>
      Schema.decodeUnknownSync(SpecCommand)(spec.subcommands[name]),
    readSpec(),
  )

const helpFor = async (path: readonly string[]): Promise<HelpDoc.HelpDoc> => {
  let help: HelpDoc.HelpDoc | undefined
  await Effect.runPromise(
    Command.runWith(pfcliCommand, { version })([...path, "--help"]).pipe(
      Effect.provideService(CliOutput.Formatter, {
        ...CliOutput.defaultFormatter(),
        formatHelpDoc: (doc) => {
          help = doc
          return ""
        },
      }),
      Effect.provideService(Console.Console, { ...console, log: () => {} }),
      Effect.provide(NodeServices.layer),
    ),
  )
  if (!help) throw new Error(`No help for ${path.join(" ")}`)
  return help
}

// Public help is independent of the private Effect config the exporter reads.
// This catches silent omissions on upgrades, beyond unsupported-report checks.
test("exported public tree matches Effect help, aliases and required syntax", async () => {
  expect(generateWithReport(pfcliCommand).unsupported).toEqual([])
  const markdown = await readFile(join(dist, "command-reference.md"), "utf8")
  const visit = async (
    spec: typeof SpecCommand.Type,
    path: readonly string[],
  ): Promise<void> => {
    const help = await helpFor(path)
    if (path.join(" ") === "init") {
      // Fail on an upstream fix so the exception and maintained notes are reviewed.
      expect(
        help.flags.find((flag) => flag.name === "identity-provider")?.required,
      ).toBe(true)
    }
    const children = help.subcommands?.flatMap((group) => group.commands) ?? []
    expect(Object.keys(spec.subcommands).sort()).toEqual(
      children.map((child) => child.name).sort(),
    )
    expect(
      spec.flags.map((flag) => ({
        name: flag.name,
        required: flag.required ?? false,
        aliases: [
          ...flag.short.map((name) => `-${name}`),
          ...flag.long
            .filter((name) => name !== flag.name)
            .map((name) => `--${name}`),
        ],
      })),
    ).toEqual(
      help.flags.map((flag) => ({
        name: flag.name,
        // Effect help reports atLeast(0) as required; check parsing separately.
        required:
          path.join(" ") === "init" && flag.name === "identity-provider"
            ? false
            : flag.required,
        aliases: [...flag.aliases],
      })),
    )
    expect(
      spec.args.map((arg) => ({
        name: arg.name,
        required: arg.required ?? false,
        variadic: arg.var ?? false,
      })),
    ).toEqual(
      (help.args ?? []).map((arg) => ({
        name: arg.name,
        required: arg.required,
        variadic: arg.variadic,
      })),
    )
    expect(markdown).toContain(
      `\`pfcli${path.length ? ` ${path.join(" ")}` : ""}\``,
    )
    for (const child of children)
      await visit(
        Schema.decodeUnknownSync(SpecCommand)(spec.subcommands[child.name]),
        [...path, child.name],
      )
  }
  await visit(readSpec(), [])
  for (const flag of (await helpFor([])).globalFlags ?? []) {
    expect(markdown).toContain(`--${flag.name}`)
    for (const alias of flag.aliases) expect(markdown).toContain(`\`${alias}\``)
    if (flag.type.startsWith("<")) {
      for (const choice of flag.type.slice(1, -1).split("|"))
        expect(markdown).toContain(`\`${choice}\``)
    }
  }
  for (const file of ["pfcli.usage.kdl", "command-reference.md"]) {
    expect(await readFile(join(dist, file), "utf8")).not.toContain(
      "--ci-provider-user",
    )
  }
})

const parse = async (
  path: readonly string[],
  args: readonly string[],
  config: Record<string, string> = {},
): Promise<Record<string, unknown>> => {
  let command: Command.Command.Any = pfcliCommand
  for (const name of path) {
    const child = command.subcommands
      .flatMap((group) => group.commands)
      .find((child) => child.name === name)
    if (!child) throw new Error(`Missing command ${path.join(" ")}`)
    command = child
  }
  let parsed: unknown
  // Real parser and declarations, inert execution sink: no operational handler.
  const sink = command.pipe(
    Command.withHandler((input) =>
      Effect.sync(() => {
        parsed = input
      }),
    ),
  )
  await Effect.runPromise(
    Command.runWith(sink, { version, renderErrors: false })(args).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown(config),
      ),
      Effect.provideService(Console.Console, { ...console, log: () => {} }),
      Effect.provide(NodeServices.layer),
    ),
  )
  return Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
    parsed,
  )
}

test("exported defaults, literal choices, repeated flags and variadic arguments match parsing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pfcli-parse-"))
  try {
    const build = specAt(["build"])
    const defaults = await parse(["build"], [directory])
    expect(build.flags.find((flag) => flag.name === "output")?.default).toEqual(
      [String(defaults["outputDir"])],
    )
    expect(
      (await parse(["build"], ["-o", "custom", directory]))["outputDir"],
    ).toBe("custom")
    const mode = specAt(["db", "upload"]).flags.find(
      (flag) => flag.name === "mode",
    )
    expect(mode?.default).toEqual([
      String((await parse(["db", "upload"], []))["mode"]),
    ])
    expect(mode?.arg?.choices?.choices.length).toBeGreaterThan(0)
    for (const choice of mode?.arg?.choices?.choices ?? []) {
      expect((await parse(["db", "upload"], ["--mode", choice]))["mode"]).toBe(
        choice,
      )
    }
    await expect(
      parse(["db", "upload"], ["--mode", "invalid-mode"]),
    ).rejects.toThrow()
    const providers = specAt(["init"]).flags.find(
      (flag) => flag.name === "identity-provider",
    )
    expect(providers?.var).toBe(true)
    expect(
      (await parse(["init"], ["--email", "example@example.com", directory]))[
        "providers"
      ],
    ).toEqual([])
    // The fallback is intentionally documented outside KDL, which cannot encode it.
    expect(
      (
        await parse(["init"], ["--email", "example@example.com"], {
          PF_ORG: directory,
        })
      )["orgPath"],
    ).toBe(directory)
    const choices = providers?.arg?.choices?.choices ?? []
    expect(choices.length).toBeGreaterThan(0)
    const initArgs = [
      "--email",
      "example@example.com",
      ...choices.flatMap((choice) => ["--identity-provider", choice]),
      directory,
    ]
    expect((await parse(["init"], initArgs))["providers"]).toEqual(choices)
    await expect(
      parse(
        ["init"],
        [
          "--email",
          "example@example.com",
          "--identity-provider",
          "invalid-provider",
          directory,
        ],
      ),
    ).rejects.toThrow()
    const config = await parse(
      ["config", "set"],
      ["--project", "fixture", "--stage", "Development", "KEY", "value"],
    )
    expect(config["args"]).toEqual(["KEY", "value"])
    expect(specAt(["config", "set"]).args[0]?.var).toBe(true)
    expect(
      specAt(["config", "set"]).flags.find((flag) => flag.name === "secret")
        ?.default,
    ).toEqual([String(config["isSecret"])])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("reference generation is deterministic and matches distribution artifacts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pfcli-reference-"))
  try {
    await generateReference(directory)
    for (const file of ["pfcli.usage.kdl", "command-reference.md"]) {
      expect(await readFile(join(directory, file), "utf8")).toBe(
        await readFile(join(dist, file), "utf8"),
      )
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("offline command-tree import/export does not perform operational IO", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pfcli-offline-"))
  try {
    const result = Bun.spawnSync(
      [
        process.execPath,
        fileURLToPath(import.meta.resolve("./fixtures/export-offline.ts")),
      ],
      {
        env: {
          PATH: process.env["PATH"],
          HOME: directory,
          PFCLI_CREDENTIALS_PATH: join(directory, "credentials.json"),
          SQLITE_DATABASE_PATH: join(directory, "pf.db"),
        },
        timeout: 15_000,
      },
    )
    expect(result.stderr.toString()).toBe("")
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toBe(
      await readFile(join(dist, "pfcli.usage.kdl"), "utf8"),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
