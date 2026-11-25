#!/usr/bin/env bun

import { stripVTControlCharacters } from "node:util"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, Effect, Option } from "effect"
import {
  Argument,
  CliOutput,
  CliError as CliParseError,
  Command,
  Flag,
} from "effect/cli"
import { FetchHttpClient } from "effect/http"
import { version } from "../package.json" with { type: "json" }
import { runAuthLogin } from "./commands/auth/login"
import { runAuthStatus } from "./commands/auth/status"
import { runExecutionList } from "./commands/executions/list"
import { runExecutionRestart } from "./commands/executions/restart"
import {
  runInvitationCreate,
  runInvitationDelete,
  runInvitationList,
  runInvitationRegistrationLink,
} from "./commands/invitation"
import {
  runListsDescribe,
  runListsList,
  runRecordsRead,
} from "./commands/lists/read"
import { runPasskeysList } from "./commands/passkeys/list"
import { runProcessStart } from "./commands/process/start"
import { runProcessList } from "./commands/processes/list"
import { runRecordMutation } from "./commands/records/mutate"
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

const withCliFailureConsole = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  structured: boolean,
) =>
  Console.consoleWith((console) =>
    effect.pipe(
      Effect.provideService(Console.Console, {
        ...console,
        error: (...args) => {
          const message = stripVTControlCharacters(
            args.map(String).join(" "),
          ).trim()
          process.stderr.write(
            structured
              ? `${JSON.stringify({ error: { code: "COMMAND_FAILED", message } })}\n`
              : `❌ ${message}\n`,
          )
        },
      }),
    ),
  )

const reportJsonCommandError = (error: Pick<CliError, "code" | "message">) =>
  Effect.sync(() => {
    process.stderr.write(
      `${JSON.stringify({ error: { code: error.code ?? "REQUEST_FAILED", message: error.message } })}\n`,
    )
    process.exitCode = 1
  })

const handleJsonCliError = <A, R>(effect: Effect.Effect<A, CliError, R>) =>
  effect.pipe(Effect.catchTag("CliError", reportJsonCommandError))

const baseUrl = Argument.String("base-url").pipe(
  Argument.withDescription("Organisation Dashboard base URL"),
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

const processPathArgument = Argument.String("process-path").pipe(
  Argument.withDescription("Path of the Process to start"),
)

const processInput = Flag.String("input").pipe(
  Flag.optional,
  Flag.withDescription("JSON object to pass to the Process start form"),
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

const page = Flag.Int("page").pipe(
  Flag.withDefault(1),
  Flag.withDescription("1-based results page"),
)
const limit = Flag.Int("limit").pipe(
  Flag.withDefault(50),
  Flag.withDescription("Results per page (maximum 100)"),
)
const processPath = Flag.String("process-path").pipe(
  Flag.optional,
  Flag.withDescription("Only results for this Process path"),
)
const status = Flag.String("status").pipe(
  Flag.optional,
  Flag.withDescription("Only results with this status"),
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

const executionsRestartCommand = Command.make(
  "restart",
  {
    executionId: Argument.String("execution-id").pipe(
      Argument.withDescription("ID of the failed Process Execution to restart"),
    ),
  },
  ({ executionId }) => handleCliError(runExecutionRestart(executionId)),
).pipe(
  Command.withDescription(
    "Restart a failed Process Execution and print the result as JSON",
  ),
  Command.withExamples([{ command: "pforg executions restart execution-id" }]),
)

const executionsCommand = Command.make("executions", {}).pipe(
  Command.withDescription("Process Execution commands"),
  Command.withSubcommands([executionsListCommand, executionsRestartCommand]),
)

const listPath = Argument.String("list-path").pipe(
  Argument.withDescription("Exact authored List path, for example /contacts"),
)
const listsCommand = Command.make("lists", {}).pipe(
  Command.withDescription(
    "Discover accessible Lists and their caller-aware schemas",
  ),
  Command.withSubcommands([
    Command.make("list", {}, () => handleJsonCliError(runListsList)).pipe(
      Command.withDescription(
        "List accessible Lists and their operations as JSON",
      ),
      Command.withExamples([{ command: "pforg lists list" }]),
    ),
    Command.make("describe", { listPath }, ({ listPath }) =>
      handleJsonCliError(runListsDescribe(listPath)),
    ).pipe(
      Command.withDescription(
        "Describe a List's caller-aware input and result schemas",
      ),
      Command.withExamples([{ command: "pforg lists describe /contacts" }]),
    ),
  ]),
)
const recordId = Argument.String("record-id").pipe(
  Argument.withDescription("Record ID returned by the List API"),
)
const recordInputs = {
  input: Flag.String("input").pipe(
    Flag.optional,
    Flag.withDescription("JSON object; choose exactly one input source"),
  ),
  inputFile: Flag.String("input-file").pipe(
    Flag.optional,
    Flag.withDescription(
      "Read a JSON object from this file; choose exactly one input source",
    ),
  ),
  inputStdin: Flag.Boolean("input-stdin").pipe(
    Flag.withDefault(false),
    Flag.withDescription(
      "Read a JSON object from stdin; choose exactly one input source",
    ),
  ),
}
const recordsCommand = Command.make("records", {}).pipe(
  Command.withDescription(
    "Read and mutate records through authored List operations",
  ),
  Command.withSubcommands([
    Command.make(
      "list",
      {
        listPath,
        page: Flag.Int("page").pipe(
          Flag.optional,
          Flag.withDescription("1-based page (API default when omitted)"),
        ),
        limit: Flag.Int("limit").pipe(
          Flag.optional,
          Flag.withDescription("Page size (List default when omitted)"),
        ),
        filter: Flag.String("filter").pipe(
          Flag.optional,
          Flag.withDescription("Existing List text filter"),
        ),
        sort: Flag.String("sort").pipe(
          Flag.optional,
          Flag.withDescription('JSON: {"field":"name","direction":"ASC"}'),
        ),
      },
      ({ listPath, page, limit, filter, sort }) =>
        handleJsonCliError(
          runRecordsRead(listPath, {
            kind: "browse",
            options: {
              page: Option.getOrUndefined(page),
              limit: Option.getOrUndefined(limit),
              filter: Option.getOrUndefined(filter),
              sort: Option.getOrUndefined(sort),
            },
          }),
        ),
    ).pipe(
      Command.withDescription("Read one page of List records as JSON"),
      Command.withExamples([
        { command: "pforg records list /contacts --page 2 --limit 25" },
      ]),
    ),
    Command.make("get", { listPath, recordId }, ({ listPath, recordId }) =>
      handleJsonCliError(
        runRecordsRead(listPath, { kind: "detail", id: recordId }),
      ),
    ).pipe(
      Command.withDescription(
        "Read the List's detail projection for one record as JSON",
      ),
      Command.withExamples([
        { command: "pforg records get /contacts record-id" },
      ]),
    ),
    Command.make("create", { listPath, ...recordInputs }, (args) =>
      handleCliError(
        runRecordMutation(args.listPath, {
          kind: "create",
          sources: {
            input: Option.getOrUndefined(args.input),
            inputFile: Option.getOrUndefined(args.inputFile),
            inputStdin: args.inputStdin,
          },
        }),
      ),
    ).pipe(
      Command.withDescription(
        "Create a record through the List's authored operation",
      ),
      Command.withExamples([
        {
          command: `pforg records create /contacts --input '{"name":"Example"}'`,
        },
      ]),
    ),
    Command.make("update", { listPath, recordId, ...recordInputs }, (args) =>
      handleCliError(
        runRecordMutation(args.listPath, {
          kind: "update",
          id: args.recordId,
          sources: {
            input: Option.getOrUndefined(args.input),
            inputFile: Option.getOrUndefined(args.inputFile),
            inputStdin: args.inputStdin,
          },
        }),
      ),
    ).pipe(
      Command.withDescription(
        "Update a record through the List's authored operation",
      ),
      Command.withExamples([
        {
          command:
            "pforg records update /contacts record-id --input-file ./changes.json",
        },
      ]),
    ),
    Command.make("delete", { listPath, recordId }, (args) =>
      handleCliError(
        runRecordMutation(args.listPath, { kind: "delete", id: args.recordId }),
      ),
    ).pipe(
      Command.withDescription(
        "Invoke the List's authored delete operation for a record",
      ),
      Command.withExamples([
        { command: "pforg records delete /contacts record-id" },
      ]),
    ),
  ]),
)

const passkeysCommand = Command.make("passkeys", {}).pipe(
  Command.withDescription("Your registered passkeys"),
  Command.withSubcommands([
    Command.make("list", {}, () => handleJsonCliError(runPasskeysList)).pipe(
      Command.withDescription("List your registered passkeys as a JSON array"),
      Command.withExamples([{ command: "pforg passkeys list" }]),
    ),
  ]),
)

const invitationCommand = Command.make("invitation", {}).pipe(
  Command.withDescription(
    "Manage Invitations and issue passkey Registration Links",
  ),
  Command.withSubcommands([
    Command.make("list", {}, () => handleJsonCliError(runInvitationList)).pipe(
      Command.withDescription(
        "List all Invitations across lifecycle statuses and pages as JSON",
      ),
      Command.withExamples([{ command: "pforg invitation list" }]),
    ),
    Command.make(
      "delete",
      {
        invitationId: Argument.String("invitation-id").pipe(
          Argument.withDescription(
            "Exact Invitation ID from pforg invitation list",
          ),
        ),
      },
      ({ invitationId }) =>
        handleJsonCliError(runInvitationDelete(invitationId)),
    ).pipe(
      Command.withDescription("Delete a pending Invitation by ID"),
      Command.withExamples([
        { command: "pforg invitation delete invitation-id" },
      ]),
    ),
    Command.make(
      "create",
      {
        email: Flag.String("email").pipe(
          Flag.withDescription("Invitee email address"),
        ),
        roles: Flag.String("role").pipe(
          Flag.atLeast(1),
          Flag.withDescription(
            "Role path to grant; required, repeat for multiple roles",
          ),
        ),
        registrationLink: Flag.Boolean("registration-link").pipe(
          Flag.withDefault(false),
          Flag.withDescription(
            "Also issue a secret, single-use passkey Registration Link",
          ),
        ),
      },
      (input) => handleJsonCliError(runInvitationCreate(input)),
    ).pipe(
      Command.withDescription("Create an Invitation with explicit role paths"),
      Command.withExamples([
        {
          command:
            'pforg invitation create --email person@example.com --role "/Some Role" --role "/Other Role"',
        },
      ]),
    ),
    Command.make(
      "registration-link",
      {
        email: Flag.String("email").pipe(
          Flag.withDescription("Email address of the pending Invitation"),
        ),
        rotate: Flag.Boolean("rotate").pipe(
          Flag.withDefault(false),
          Flag.withDescription(
            "Invalidate an existing active or expired link and issue a new one",
          ),
        ),
      },
      ({ email, rotate }) =>
        handleJsonCliError(runInvitationRegistrationLink(email, rotate)),
    ).pipe(
      Command.withDescription(
        "Issue a secret passkey Registration Link for a pending Invitation",
      ),
      Command.withExamples([
        {
          command:
            "pforg invitation registration-link --email person@example.com",
        },
      ]),
    ),
  ]),
)

// Shared with the build-only reference generator. Importing does not run the CLI
// or provide runtime layers; execution remains behind import.meta.main below.
export const pforgCommand = Command.make("pforg", {}).pipe(
  Command.withDescription("Process Focus organisation-runtime CLI"),
  Command.withSubcommands([
    invitationCommand,
    passkeysCommand,
    listsCommand,
    recordsCommand,
    authCommand,
    processCommand,
    processesCommand,
    todosCommand,
    executionsCommand,
  ]),
)

const cli = Command.runWith(pforgCommand, {
  version,
  renderErrors: false,
})

// Built-in value validation errors lack ShowHelp.commandPath. Skip the two
// value-taking global options supported by Effect's default CLI configuration.
const rootCommandArgument = (argv: readonly string[]): string | undefined => {
  for (let index = 2; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === undefined) return undefined
    if (argument === "--") return argv[index + 1]
    if (argument === "--log-level" || argument === "--completions") index++
    else if (!argument.startsWith("-")) return argument
  }
  return undefined
}

export const runPforgCommand = (argv: readonly string[]) =>
  withCliFailureConsole(
    Effect.gen(function* () {
      const console = yield* Console.Console
      const formatter = yield* CliOutput.Formatter
      let help: string | undefined
      let failed = false
      yield* cli(argv.slice(2)).pipe(
        Effect.provideService(CliOutput.Formatter, {
          ...formatter,
          formatHelpDoc: (document) => {
            help = formatter.formatHelpDoc(document)
            return help
          },
        }),
        Effect.provideService(Console.Console, {
          ...console,
          // The v4 parser prints help before exposing whether parsing failed.
          // Delay only that output so argument errors stay on stderr.
          log: (...args) => {
            if (args.length === 1 && args[0] === help) return
            console.log(...args)
          },
        }),
        Effect.catchIf(CliParseError.isCliError, (error) =>
          Effect.gen(function* () {
            const errors = error._tag === "ShowHelp" ? error.errors : [error]
            failed = errors.length > 0
            const command =
              error._tag === "ShowHelp"
                ? error.commandPath[1]
                : rootCommandArgument(argv)
            if (
              command === "lists" ||
              command === "records" ||
              command === "invitation" ||
              command === "passkeys"
            ) {
              if (failed) {
                yield* reportJsonCommandError({
                  code: "COMMAND_FAILED",
                  message: errors.map((failure) => failure.message).join("\n"),
                })
              }
            } else {
              for (const failure of errors) {
                yield* Console.error(failure.message)
              }
            }
            process.exitCode = failed ? 1 : 0
          }),
        ),
      )
      if (!failed && help !== undefined) yield* Console.log(help)
    }),
    rootCommandArgument(argv) === "records",
  )

if (import.meta.main) {
  runPforgCommand(process.argv).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  )
}
