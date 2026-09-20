#!/usr/bin/env bun

import { stripVTControlCharacters } from "node:util"
import { Args, Command, Options, ValidationError } from "@effect/cli"
import { FetchHttpClient } from "@effect/platform"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Console, Effect, Option } from "effect"
import { version } from "../package.json" with { type: "json" }
import { runAuthLogin } from "./commands/auth/login"
import { runAuthStatus } from "./commands/auth/status"
import { runExecutionList } from "./commands/executions/list"
import { runProcessStart } from "./commands/process/start"
import { runProcessList } from "./commands/processes/list"
import { runTodoList } from "./commands/todos/list"
import type { AuthError, CliError } from "./errors"

const reportCommandError = (error: { readonly message: string }) =>
  Effect.gen(function* () {
    yield* Console.error(error.message)
    yield* Effect.sync(() => {
      process.exitCode = 1
    })
  })

const handleAuthError = <A, R>(effect: Effect.Effect<A, AuthError, R>) =>
  effect.pipe(Effect.catchTag("AuthError", reportCommandError))

const handleCliError = <A, R>(effect: Effect.Effect<A, CliError, R>) =>
  effect.pipe(Effect.catchTag("CliError", reportCommandError))

const withCliFailureConsole = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Console.consoleWith((console) =>
    effect.pipe(
      Console.withConsole({
        ...console,
        error: (...args) =>
          Effect.sync(() => {
            const message = stripVTControlCharacters(
              args.map(String).join(" "),
            ).trim()
            process.stderr.write(`❌ ${message}\n`)
          }),
      }),
    ),
  )

const baseUrl = Args.text({ name: "base-url" }).pipe(
  Args.withDescription("Organisation Dashboard base URL"),
)

const authLoginCommand = Command.make("login", { baseUrl }, ({ baseUrl }) =>
  handleAuthError(runAuthLogin(baseUrl)),
).pipe(Command.withDescription("Log in through the organisation Dashboard"))

const authStatusCommand = Command.make("status", {}, () =>
  handleAuthError(runAuthStatus),
).pipe(
  Command.withDescription("Show the current organisation and token expiry"),
)

const authCommand = Command.make("auth", {}).pipe(
  Command.withDescription("Authentication commands"),
  Command.withSubcommands([authLoginCommand, authStatusCommand]),
)

const processPathArgument = Args.text({ name: "process-path" }).pipe(
  Args.withDescription("Path of the Process to start"),
)

const processInput = Options.text("input").pipe(
  Options.optional,
  Options.withDescription("JSON object to pass to the Process start form"),
)

const processStartCommand = Command.make(
  "start",
  { processPath: processPathArgument, input: processInput },
  ({ processPath, input }) =>
    handleCliError(
      runProcessStart(
        processPath,
        Option.match(input, {
          onNone: () => undefined,
          onSome: (value) => value,
        }),
      ),
    ),
).pipe(Command.withDescription("Start a Process and print its start payload"))

const processCommand = Command.make("process", {}).pipe(
  Command.withDescription("Process commands"),
  Command.withSubcommands([processStartCommand]),
)

const page = Options.integer("page").pipe(
  Options.withDefault(1),
  Options.withDescription("1-based results page"),
)
const limit = Options.integer("limit").pipe(
  Options.withDefault(50),
  Options.withDescription("Results per page (maximum 100)"),
)
const processPath = Options.text("process-path").pipe(
  Options.optional,
  Options.withDescription("Only results for this Process path"),
)
const status = Options.text("status").pipe(
  Options.optional,
  Options.withDescription("Only results with this status"),
)

const todosListCommand = Command.make(
  "list",
  { page, limit, processPath, status },
  ({ page, limit, processPath, status }) =>
    handleCliError(
      runTodoList({
        page,
        limit,
        processPath: Option.getOrUndefined(processPath),
        status: Option.getOrUndefined(status),
      }),
    ),
).pipe(Command.withDescription("List Todos you can complete as JSON"))

const todosCommand = Command.make("todos", {}).pipe(
  Command.withDescription("Todo commands"),
  Command.withSubcommands([todosListCommand]),
)

const processesListCommand = Command.make(
  "list",
  { page, limit, processPath, status },
  ({ page, limit, processPath, status }) =>
    handleCliError(
      runProcessList({
        page,
        limit,
        processPath: Option.getOrUndefined(processPath),
        status: Option.getOrUndefined(status),
      }),
    ),
).pipe(Command.withDescription("List Processes you can start as JSON"))

const processesCommand = Command.make("processes", {}).pipe(
  Command.withDescription("Process catalog commands"),
  Command.withSubcommands([processesListCommand]),
)

const executionsListCommand = Command.make(
  "list",
  { page, limit, processPath, status },
  ({ page, limit, processPath, status }) =>
    handleCliError(
      runExecutionList({
        page,
        limit,
        processPath: Option.getOrUndefined(processPath),
        status: Option.getOrUndefined(status),
      }),
    ),
).pipe(Command.withDescription("List Process Executions you can view as JSON"))

const executionsCommand = Command.make("executions", {}).pipe(
  Command.withDescription("Process Execution commands"),
  Command.withSubcommands([executionsListCommand]),
)

const app = Command.make("pforg", {}).pipe(
  Command.withDescription("Process Focus organisation-runtime CLI"),
  Command.withSubcommands([
    authCommand,
    processCommand,
    processesCommand,
    todosCommand,
    executionsCommand,
  ]),
)

const cli = Command.run(app, {
  name: "pforg",
  version,
})

export const runPforgCommand = (argv: readonly string[]) =>
  withCliFailureConsole(cli(argv)).pipe(
    Effect.catchIf(ValidationError.isValidationError, (error) =>
      Effect.sync(() => {
        process.exitCode = ValidationError.isHelpRequested(error) ? 0 : 1
      }),
    ),
  )

if (import.meta.main) {
  runPforgCommand(process.argv).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provide(NodeContext.layer),
    NodeRuntime.runMain,
  )
}
