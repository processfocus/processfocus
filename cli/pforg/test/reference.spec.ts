import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { NodeServices } from "@effect/platform-node"
import { Console, Effect, Schema } from "effect"
import { CliOutput, Command, type HelpDoc } from "effect/cli"
import { FetchHttpClient } from "effect/http"
import { generateWithReport } from "usage-spec-effect"
import { version } from "../package.json"
import { generateReference } from "../scripts/generate-reference"
import { pforgCommand } from "../src/main"
import { expect, test } from "bun:test"

const dist = resolve(import.meta.dir, "../dist")
const Parameter = Schema.Struct({
  name: Schema.String,
  required: Schema.optional(Schema.Boolean),
  var: Schema.optional(Schema.Boolean),
  var_min: Schema.optional(Schema.Number),
  default: Schema.optional(Schema.Array(Schema.String)),
})
const SpecCommand = Schema.Struct({
  subcommands: Schema.Record(Schema.String, Schema.Unknown),
  args: Schema.Array(Parameter),
  flags: Schema.Array(Parameter),
})

const readSpec = () => {
  const result = Bun.spawnSync([
    "usage",
    "generate",
    "json",
    "--file",
    join(dist, "pforg.usage.kdl"),
  ])
  expect(result.exitCode).toBe(0)
  return Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Struct({ cmd: SpecCommand })),
  )(result.stdout.toString()).cmd
}

const helpFor = async (path: readonly string[]): Promise<HelpDoc.HelpDoc> => {
  let help: HelpDoc.HelpDoc | undefined
  await Effect.runPromise(
    Command.runWith(pforgCommand, { version })([...path, "--help"]).pipe(
      Effect.provideService(CliOutput.Formatter, {
        ...CliOutput.defaultFormatter(),
        formatHelpDoc: (doc) => {
          help = doc
          return ""
        },
      }),
      Effect.provideService(Console.Console, { ...console, log: () => {} }),
      Effect.provide(NodeServices.layer),
      Effect.provide(FetchHttpClient.layer),
    ),
  )
  if (!help) throw new Error(`No help for ${path.join(" ")}`)
  return help
}

// Independent public HelpDoc output catches silent omissions when the exporter
// reads a changed private Effect config. No copied command/flag inventory.
test("exported commands, positionals and flags match Effect's public help", async () => {
  expect(generateWithReport(pforgCommand).unsupported).toEqual([])
  const markdown = await readFile(join(dist, "command-reference.md"), "utf8")
  const visit = async (
    spec: typeof SpecCommand.Type,
    path: readonly string[],
  ): Promise<void> => {
    const help = await helpFor(path)
    const children = help.subcommands?.flatMap((group) => group.commands) ?? []
    expect(Object.keys(spec.subcommands).sort()).toEqual(
      children.map((child) => child.name).sort(),
    )
    expect(
      spec.flags.map((flag) => ({
        name: flag.name,
        required: flag.required ?? false,
      })),
    ).toEqual(
      help.flags.map((flag) => ({ name: flag.name, required: flag.required })),
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
      `\`pforg${path.length ? ` ${path.join(" ")}` : ""}\``,
    )
    for (const child of children) {
      await visit(
        Schema.decodeUnknownSync(SpecCommand)(spec.subcommands[child.name]),
        [...path, child.name],
      )
    }
  }
  await visit(readSpec(), [])
})

const leaf = (group: string, name: string) => {
  const parent = pforgCommand.subcommands
    .flatMap((group) => group.commands)
    .find((command) => command.name === group)
  const command = parent?.subcommands
    .flatMap((group) => group.commands)
    .find((command) => command.name === name)
  if (!command) throw new Error(`Missing command: ${group} ${name}`)
  return command
}

const parse = async (
  group: string,
  name: string,
  args: readonly string[],
): Promise<unknown> => {
  let parsed: unknown
  // Replace only the test's execution sink: the real declarations/parser run,
  // while no API handler is invoked.
  const command = leaf(group, name).pipe(
    Command.withHandler((input) =>
      Effect.sync(() => {
        parsed = input
      }),
    ),
  )
  await Effect.runPromise(
    Command.runWith(command, { version, renderErrors: false })(args).pipe(
      Effect.provideService(Console.Console, { ...console, log: () => {} }),
      Effect.provide(NodeServices.layer),
    ),
  )
  return parsed
}

test("export preserves parsed defaults and required repeatable invitation roles", async () => {
  const root = readSpec()
  for (const group of ["todos", "processes", "executions"]) {
    const parent = Schema.decodeUnknownSync(SpecCommand)(
      root.subcommands[group],
    )
    const command = Schema.decodeUnknownSync(SpecCommand)(
      parent.subcommands["list"],
    )
    const parsed = Schema.decodeUnknownSync(
      Schema.Struct({ page: Schema.Number, limit: Schema.Number }),
    )(await parse(group, "list", []))
    for (const name of ["page", "limit"] as const) {
      expect(command.flags.find((flag) => flag.name === name)?.default).toEqual(
        [String(parsed[name])],
      )
    }
  }
  const invitation = Schema.decodeUnknownSync(SpecCommand)(
    root.subcommands["invitation"],
  )
  const create = Schema.decodeUnknownSync(SpecCommand)(
    invitation.subcommands["create"],
  )
  expect(create.flags.find((flag) => flag.name === "role")).toMatchObject({
    required: true,
    var: true,
    var_min: 1,
  })
  await expect(
    parse("invitation", "create", ["--email", "person@example.com"]),
  ).rejects.toThrow()
  const parsed = Schema.decodeUnknownSync(
    Schema.Struct({
      roles: Schema.Array(Schema.String),
      registrationLink: Schema.Boolean,
    }),
  )(
    await parse("invitation", "create", [
      "--email",
      "person@example.com",
      "--role",
      "/One",
      "--role",
      "/Two",
    ]),
  )
  expect(parsed.roles).toEqual(["/One", "/Two"])
  expect(
    create.flags.find((flag) => flag.name === "registration-link")?.default,
  ).toEqual([String(parsed.registrationLink)])

  for (const [group, name, args, flag, key] of [
    [
      "invitation",
      "registration-link",
      ["--email", "person@example.com"],
      "rotate",
      "rotate",
    ],
    ["records", "create", ["/contacts"], "input-stdin", "inputStdin"],
    [
      "records",
      "update",
      ["/contacts", "record-id"],
      "input-stdin",
      "inputStdin",
    ],
  ] as const) {
    const parent = Schema.decodeUnknownSync(SpecCommand)(
      root.subcommands[group],
    )
    const command = Schema.decodeUnknownSync(SpecCommand)(
      parent.subcommands[name],
    )
    const input = Schema.decodeUnknownSync(
      Schema.Record(Schema.String, Schema.Unknown),
    )(await parse(group, name, args))
    expect(
      command.flags.find((parameter) => parameter.name === flag)?.default,
    ).toEqual([String(input[key])])
  }
})

test("maintained runner notes cover every built-in spelling and choice", async () => {
  const markdown = await readFile(join(dist, "command-reference.md"), "utf8")
  const help = await helpFor([])
  for (const flag of help.globalFlags ?? []) {
    expect(markdown).toContain(`--${flag.name}`)
    for (const alias of flag.aliases) expect(markdown).toContain(`\`${alias}\``)
    if (flag.type.startsWith("<")) {
      for (const choice of flag.type.slice(1, -1).split("|"))
        expect(markdown).toContain(`\`${choice}\``)
    }
  }
})

test("reference generation is deterministic and matches the built artifacts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pforg-reference-"))
  try {
    await generateReference(directory)
    for (const file of ["pforg.usage.kdl", "command-reference.md"]) {
      expect(await readFile(join(directory, file), "utf8")).toBe(
        await readFile(join(dist, file), "utf8"),
      )
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("offline import and export do not touch credentials, network, browsers or listeners", async () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      fileURLToPath(import.meta.resolve("./fixtures/export-offline.ts")),
    ],
    {
      env: {
        ...process.env,
        PFORG_CREDENTIALS_PATH: "/must-not-read-pforg-credentials",
      },
      timeout: 10_000,
    },
  )
  expect(result.stderr.toString()).toBe("")
  expect(result.exitCode).toBe(0)
  expect(result.stdout.toString()).toBe(
    await readFile(join(dist, "pforg.usage.kdl"), "utf8"),
  )
})
