#!/usr/bin/env bun

import { Args, Command, Options, ValidationError } from "@effect/cli"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { DATABASE_UPLOAD_MODES } from "@processfocus/hosting-contract"
import { Config, Console, Effect, Option } from "effect"
import { runAuthLogin } from "./commands/auth/login"
import { runBuild } from "./commands/build"
import { runConfigCopyNew } from "./commands/config/copy-new"
import { runConfigDelete } from "./commands/config/delete"
import { runConfigGet } from "./commands/config/get"
import { runConfigList } from "./commands/config/list"
import { runConfigSet } from "./commands/config/set"
import { runCustomDomain } from "./commands/custom-domain"
import { runDownloadDb } from "./commands/db/download"
import { runRollbackDb } from "./commands/db/rollback"
import { runDatabaseShell } from "./commands/db/shell"
import { runUploadDb } from "./commands/db/upload"
import { runDeploy } from "./commands/deploy"
import { runDestroy } from "./commands/destroy"
import { runEnvAdd } from "./commands/env/add"
import { runEnvList } from "./commands/env/list"
import { runGetFrontendJwt } from "./commands/get-frontend-jwt"
import { runGrantRole } from "./commands/grant-role"
import { runImport, runImportWatch } from "./commands/import"
import { SUPPORTED_PROVIDERS, runInit } from "./commands/init"
import { runInvitationRegistrationLink } from "./commands/invitation-registration-link"
import { runCanaryLogs, runLogs } from "./commands/logs"
import { runMigrate } from "./commands/migrate"
import { runMigrateCustom } from "./commands/migrate-custom"
import { runProjects } from "./commands/projects"
import { runRefreshFrontendJwt } from "./commands/refresh-frontend-jwt"
import { runSkillsGet, runSkillsList } from "./commands/skills"
import { runStageAdd } from "./commands/stage/add"
import { runStageList } from "./commands/stage/list"
import {
  BuildError,
  CliError,
  type CustomDomainError,
  GraphqlSchemaError,
  PolicyFileError,
} from "./errors"
import { CLI_PACKAGE_VERSION } from "./package-metadata"
import {
  HIDDEN_CI_PROVIDER_USER_ENV,
  extractHiddenCiProviderUserArgs,
} from "./utils/hidden-ci-provider-user-args"
import { normalizeRollbackTimestamp } from "./utils/rollback-timestamp"

// Arguments
const orgPath = Args.directory({ name: "org-path", exists: "either" }).pipe(
  Args.withDescription("Path to the organisation directory"),
)

const initOrgPath = Args.directory({
  name: "org-path",
  exists: "either",
}).pipe(
  Args.withDescription("Path to the organisation directory to initialise"),
  Args.withFallbackConfig(Config.string("PF_ORG")),
)

// Options
const outputDir = Options.directory("output", { exists: "either" }).pipe(
  Options.withAlias("o"),
  Options.withDefault("dist"),
  Options.withDescription("Output directory for build artifacts"),
)

const projectId = Options.text("project").pipe(
  Options.optional,
  Options.withDescription("Project number (or internal ID) to deploy"),
)

const environmentId = Options.text("env").pipe(
  Options.optional,
  Options.withDescription("Environment name to deploy to"),
)

const logsProjectId = Options.text("project").pipe(
  Options.optional,
  Options.withDescription(
    "Project number (or internal ID) whose runtime logs to read",
  ),
)

const logsEnvironmentId = Options.text("env").pipe(
  Options.optional,
  Options.withDescription("Environment name whose runtime logs to read"),
)

const noWait = Options.boolean("no-wait").pipe(
  Options.withDefault(false),
  Options.withDescription(
    "Return after starting the deployment without waiting",
  ),
)

const importWatch = Options.boolean("watch").pipe(
  Options.withDefault(false),
  Options.withDescription(
    "Run an experimental watched import loop with debounce, timing and recovery",
  ),
)

const importWatchSkipInitial = Options.boolean("watch-skip-initial").pipe(
  Options.withDefault(false),
  Options.withDescription(
    "Start watch mode without its initial import after a separate bootstrap import has completed",
  ),
)

const customDomainProjectId = Options.text("project").pipe(
  Options.withDescription("Project number or internal ID"),
)

const customDomainEnvironmentId = Options.text("env").pipe(
  Options.withDescription("Environment name"),
)

const rollbackProjectId = Options.text("project").pipe(
  Options.optional,
  Options.withDescription("Project number (or internal ID) to roll back"),
)

const rollbackEnvironmentId = Options.text("env").pipe(
  Options.optional,
  Options.withDescription("Environment name to roll back"),
)

const rollbackTimestamp = Options.text("timestamp").pipe(
  Options.optional,
  Options.withDescription(
    "RFC3339 / ISO-8601 rollback timestamp; if no timezone is supplied, the local terminal timezone is used (for example 2026-04-16T18:00:00)",
  ),
)

const rollbackNoWait = Options.boolean("no-wait").pipe(
  Options.withDefault(false),
  Options.withDescription("Return after starting the rollback without waiting"),
)

const destroyProjectId = Options.text("project").pipe(
  Options.optional,
  Options.withDescription("Project number (or internal ID) to destroy from"),
)

const destroyEnvironmentId = Options.text("env").pipe(
  Options.optional,
  Options.withDescription("Environment name (or internal ID) to destroy"),
)

const destroyConfirmed = Options.boolean("yes").pipe(
  Options.withDefault(false),
  Options.withDescription(
    "Confirm deletion of the environment's AWS stacks and environment record",
  ),
)

const destroyNoWait = Options.boolean("no-wait").pipe(
  Options.withDefault(false),
  Options.withDescription("Return after starting destruction without waiting"),
)

const downloadProjectId = Options.text("project").pipe(
  Options.optional,
  Options.withDescription("Project number (or internal ID) to download from"),
)

const downloadEnvironmentId = Options.text("env").pipe(
  Options.optional,
  Options.withDescription("Environment name to download from"),
)

const downloadOutputPath = Options.text("output").pipe(
  Options.optional,
  Options.withDescription("Output SQLite file path"),
)

const shellProjectId = Options.text("project").pipe(
  // Keep this optional so --project and --env can be reported together.
  Options.optional,
  Options.withDescription(
    "Project number (or internal ID) to open a database shell for",
  ),
)

const shellEnvironmentId = Options.text("env").pipe(
  // Keep this optional so --project and --env can be reported together.
  Options.optional,
  Options.withDescription("Environment name to open a database shell for"),
)

const shellTtl = Options.text("ttl").pipe(
  Options.optional,
  Options.withDescription(
    'Database Shell session TTL; bare numbers are seconds, for example "900", "15m", or "1h"',
  ),
)

const uploadProjectId = Options.text("project").pipe(
  Options.optional,
  Options.withDescription("Project number (or internal ID) to upload to"),
)

const uploadEnvironmentId = Options.text("env").pipe(
  Options.optional,
  Options.withDescription("Environment name to upload to"),
)

const uploadMode = Options.choice("mode", [...DATABASE_UPLOAD_MODES]).pipe(
  Options.withDefault("data-copy"),
  Options.withDescription(
    "Upload mode: preserve destination authentication identity (data-copy) or restore all database state (exact-restore)",
  ),
)

const uploadSqliteFile = Args.text({ name: "sqlite-file" }).pipe(
  // Keep this optional so missing options and the missing positional file can
  // be reported together using the same concise pfcli error style.
  Args.optional,
  Args.withDescription("Local SQLite database file to upload"),
)

const initProviders = Options.choice("identity-provider", [
  ...SUPPORTED_PROVIDERS,
]).pipe(
  Options.repeated,
  Options.withDescription(
    `Identity provider to scaffold (repeatable: ${SUPPORTED_PROVIDERS.join(", ")})`,
  ),
)

const initEmail = Options.text("email").pipe(
  Options.withDescription(
    "Admin email used for the scaffolded invitation and Cedar policy",
  ),
)

const skillName = Args.text({ name: "name" }).pipe(
  Args.withDescription("Skill name to print"),
)

// Commands
const importCommand = Command.make(
  "import",
  {
    orgPath: initOrgPath,
    watch: importWatch,
    watchSkipInitial: importWatchSkipInitial,
  },
  ({ orgPath, watch, watchSkipInitial }) =>
    watch
      ? runImportWatch(orgPath, { skipInitialImport: watchSkipInitial })
      : Effect.gen(function* () {
          if (watchSkipInitial) {
            yield* Console.warn(
              "--watch-skip-initial is ignored unless --watch is also set",
            )
          }

          return yield* runImport(orgPath)
        }),
).pipe(
  Command.withDescription(
    "Import organisation to SQLite database (uses PF_ORG, SQLITE_DATABASE_PATH, or $org-path/db/pf.db)",
  ),
)

const buildCommand = Command.make(
  "build",
  { orgPath, outputDir },
  ({ orgPath, outputDir }) =>
    runBuild(orgPath, outputDir).pipe(
      Effect.catchIf(
        (error): error is BuildError | GraphqlSchemaError | PolicyFileError =>
          error instanceof BuildError ||
          error instanceof GraphqlSchemaError ||
          error instanceof PolicyFileError,
        (error) =>
          Effect.gen(function* () {
            yield* Console.error(`\n❌ ${error.message}`)
            yield* Effect.sync(() => {
              process.exitCode = 1
            })
          }),
      ),
    ),
).pipe(
  Command.withDescription(
    "Build organisation artifacts (bundled JS, GraphQL schema, Cedar policies)",
  ),
)

const projectsCommand = Command.make("projects", {}, () =>
  runProjects().pipe(
    Effect.catchTag("CliError", (error) =>
      Effect.gen(function* () {
        yield* Console.error(`\n❌ ${error.message}`)
        yield* Effect.sync(() => {
          process.exitCode = 1
        })
      }),
    ),
  ),
).pipe(
  Command.withDescription(
    "List projects in the Backend environment (tab-separated: number, name)",
  ),
)

const deployCommand = Command.make(
  "deploy",
  { orgPath, projectId, environmentId, noWait },
  ({ orgPath, projectId, environmentId, noWait }) =>
    Effect.gen(function* () {
      const missing: string[] = []
      if (Option.isNone(projectId)) {
        missing.push("--project")
      }
      if (Option.isNone(environmentId)) {
        missing.push("--env")
      }

      if (missing.length > 0) {
        return yield* new CliError({
          message: `Missing required deploy option(s): ${missing.join(", ")}.\nExample: pfcli deploy ${orgPath} --project <project-number> --env <environment-name>`,
        })
      }

      const resolvedProjectId = Option.match(projectId, {
        onNone: () => "",
        onSome: (value) => value,
      })
      const resolvedEnvironmentId = Option.match(environmentId, {
        onNone: () => "",
        onSome: (value) => value,
      })

      return yield* runDeploy(
        orgPath,
        resolvedProjectId,
        resolvedEnvironmentId,
        {
          waitForCompletion: !noWait,
        },
      )
    }).pipe(
      Effect.catchTag("CliError", (error) =>
        Effect.gen(function* () {
          yield* Console.error(`\n❌ ${error.message}`)
          yield* Effect.sync(() => {
            process.exitCode = 1
          })
        }),
      ),
    ),
).pipe(
  Command.withDescription(
    "Build org, upload dist artifact, start deploy process, and wait for completion by default",
  ),
)

const destroyCommand = Command.make(
  "destroy",
  {
    projectId: destroyProjectId,
    environmentId: destroyEnvironmentId,
    confirmed: destroyConfirmed,
    noWait: destroyNoWait,
  },
  ({ projectId, environmentId, confirmed, noWait }) =>
    Effect.gen(function* () {
      const missing: string[] = []
      if (Option.isNone(projectId)) {
        missing.push("--project")
      }
      if (Option.isNone(environmentId)) {
        missing.push("--env")
      }

      if (missing.length > 0) {
        return yield* new CliError({
          message: `Missing required destroy option(s): ${missing.join(", ")}.
Example: pfcli destroy --project <project-number> --env <environment-name> --yes`,
        })
      }

      const resolvedProjectId = Option.getOrThrow(projectId)
      const resolvedEnvironmentId = Option.getOrThrow(environmentId)

      if (!confirmed) {
        return yield* new CliError({
          message: `Confirmation required to destroy project ${resolvedProjectId}, environment ${resolvedEnvironmentId}. This command deletes the environment's AWS stacks and environment record. Re-run with --yes.`,
        })
      }

      return yield* runDestroy(resolvedProjectId, resolvedEnvironmentId, {
        waitForCompletion: !noWait,
      })
    }).pipe(
      Effect.catchTag("CliError", (error) =>
        Effect.gen(function* () {
          yield* Console.error(`\n❌ ${error.message}`)
          yield* Effect.sync(() => {
            process.exitCode = 1
          })
        }),
      ),
    ),
).pipe(
  Command.withDescription(
    "Destroy a hosted project environment and wait for completion by default",
  ),
)

const rollbackDbCommand = Command.make(
  "rollback",
  {
    projectId: rollbackProjectId,
    environmentId: rollbackEnvironmentId,
    timestamp: rollbackTimestamp,
    noWait: rollbackNoWait,
  },
  ({ projectId, environmentId, timestamp, noWait }) =>
    Effect.gen(function* () {
      const missing: string[] = []
      if (Option.isNone(projectId)) {
        missing.push("--project")
      }
      if (Option.isNone(environmentId)) {
        missing.push("--env")
      }
      if (Option.isNone(timestamp)) {
        missing.push("--timestamp")
      }

      if (missing.length > 0) {
        return yield* new CliError({
          message: `Missing required rollback option(s): ${missing.join(", ")}.
Example: pfcli db rollback --project <project-number> --env <environment-name> --timestamp 2026-04-01T00:00:00Z
Local timezone also supported: --timestamp 2026-04-16T18:00:00`,
        })
      }

      const resolvedProjectId = Option.getOrThrow(projectId)
      const resolvedEnvironmentId = Option.getOrThrow(environmentId)
      const resolvedTimestamp = normalizeRollbackTimestamp(
        Option.getOrThrow(timestamp),
      )

      return yield* runRollbackDb(
        resolvedProjectId,
        resolvedEnvironmentId,
        resolvedTimestamp,
        {
          waitForCompletion: !noWait,
        },
      )
    }).pipe(
      Effect.catchTag("CliError", (error) =>
        Effect.gen(function* () {
          yield* Console.error(`\n❌ ${error.message}`)
          yield* Effect.sync(() => {
            process.exitCode = 1
          })
        }),
      ),
    ),
).pipe(
  Command.withDescription(
    "Start a database rollback preparation process and wait for completion by default",
  ),
)

const downloadDbCommand = Command.make(
  "download",
  {
    projectId: downloadProjectId,
    environmentId: downloadEnvironmentId,
    outputPath: downloadOutputPath,
  },
  ({ projectId, environmentId, outputPath }) =>
    Effect.gen(function* () {
      const missing: string[] = []
      if (Option.isNone(projectId)) {
        missing.push("--project")
      }
      if (Option.isNone(environmentId)) {
        missing.push("--env")
      }

      if (missing.length > 0) {
        return yield* new CliError({
          message: `Missing required download option(s): ${missing.join(", ")}.
Example: pfcli db download --project <project-number> --env <environment-name> [--output ./backup.sqlite]`,
        })
      }

      return yield* runDownloadDb(
        Option.getOrThrow(projectId),
        Option.getOrThrow(environmentId),
        Option.getOrUndefined(outputPath),
      )
    }).pipe(
      Effect.catchTag("CliError", (error) =>
        Effect.gen(function* () {
          yield* Console.error(`\n❌ ${error.message}`)
          yield* Effect.sync(() => {
            process.exitCode = 1
          })
        }),
      ),
    ),
).pipe(
  Command.withDescription(
    "Download a hosted environment database to a local path",
  ),
)

const uploadDbCommand = Command.make(
  "upload",
  {
    projectId: uploadProjectId,
    environmentId: uploadEnvironmentId,
    mode: uploadMode,
    sqliteFile: uploadSqliteFile,
  },
  ({ projectId, environmentId, mode, sqliteFile }) =>
    Effect.gen(function* () {
      const missing: string[] = []
      if (Option.isNone(projectId)) {
        missing.push("--project")
      }
      if (Option.isNone(environmentId)) {
        missing.push("--env")
      }
      if (Option.isNone(sqliteFile)) {
        missing.push("<sqlite-file>")
      }

      if (missing.length > 0) {
        return yield* new CliError({
          message: `Missing required upload option(s): ${missing.join(", ")}.
Example: pfcli db upload --project <project-number> --env <environment-name> <sqlite-file>`,
        })
      }

      return yield* runUploadDb(
        Option.getOrThrow(projectId),
        Option.getOrThrow(environmentId),
        Option.getOrThrow(sqliteFile),
        { mode },
      )
    }).pipe(
      Effect.catchTag("CliError", (error) =>
        Effect.gen(function* () {
          yield* Console.error(`\n❌ ${error.message}`)
          yield* Effect.sync(() => {
            process.exitCode = 1
          })
        }),
      ),
    ),
).pipe(
  Command.withDescription(
    "Upload and apply a local SQLite database through a signed document-store URL",
  ),
)

const shellDbCommand = Command.make(
  "shell",
  {
    projectId: shellProjectId,
    environmentId: shellEnvironmentId,
    ttl: shellTtl,
  },
  ({ projectId, environmentId, ttl }) =>
    Effect.gen(function* () {
      const missing: string[] = []
      if (Option.isNone(projectId)) {
        missing.push("--project")
      }
      if (Option.isNone(environmentId)) {
        missing.push("--env")
      }

      if (missing.length > 0) {
        return yield* new CliError({
          message: `Missing required database shell option(s): ${missing.join(", ")}.
Example: pfcli db shell --project <project-number> --env <environment-name> [--ttl 15m]`,
        })
      }

      const exitCode = yield* runDatabaseShell(
        Option.getOrThrow(projectId),
        Option.getOrThrow(environmentId),
        Option.getOrUndefined(ttl),
      )

      yield* Effect.sync(() => {
        process.exitCode = exitCode
      })
    }).pipe(
      Effect.catchTag("CliError", (error) =>
        Effect.gen(function* () {
          yield* Console.error(`\n❌ ${error.message}`)
          yield* Effect.sync(() => {
            process.exitCode = 1
          })
        }),
      ),
    ),
).pipe(
  Command.withDescription(
    "Open an interactive Turso shell for a hosted environment database",
  ),
)

const dbCommand = Command.make("db", {}).pipe(
  Command.withDescription("Database commands"),
  Command.withSubcommands([
    rollbackDbCommand,
    downloadDbCommand,
    uploadDbCommand,
    shellDbCommand,
  ]),
)

const customDomainCommand = Command.make(
  "custom-domain",
  {
    projectId: customDomainProjectId,
    environmentId: customDomainEnvironmentId,
  },
  ({ projectId, environmentId }) =>
    runCustomDomain(projectId, environmentId).pipe(
      Effect.catchTag("CustomDomainError", (error: CustomDomainError) =>
        Effect.gen(function* () {
          yield* Console.error(`\n❌ ${error.message}`)
          yield* Effect.sync(() => {
            process.exitCode = 1
          })
        }),
      ),
    ),
).pipe(
  Command.withDescription(
    "Show custom-domain certificate status and required DNS records",
  ),
)

const makeLogsCommand = (
  commandName: "logs" | "canary-logs",
  description: string,
  run: (
    projectId: string,
    environmentId: string,
  ) => Effect.Effect<void, CliError>,
) =>
  Command.make(
    commandName,
    {
      // Keep these optional so missing values can use the custom error below.
      projectId: logsProjectId,
      environmentId: logsEnvironmentId,
    },
    ({ projectId, environmentId }) =>
      Effect.gen(function* () {
        const missing: string[] = []
        if (Option.isNone(projectId)) {
          missing.push("--project")
        }
        if (Option.isNone(environmentId)) {
          missing.push("--env")
        }

        if (missing.length > 0) {
          return yield* new CliError({
            message: `Missing required ${commandName} option(s): ${missing.join(", ")}.
Example: pfcli ${commandName} --project <project-number> --env <environment-name>`,
          })
        }

        return yield* run(
          Option.getOrThrow(projectId),
          Option.getOrThrow(environmentId),
        )
      }).pipe(
        Effect.catchTag("CliError", (error) =>
          Effect.gen(function* () {
            yield* Console.error(`\n❌ ${error.message}`)
            yield* Effect.sync(() => {
              process.exitCode = 1
            })
          }),
        ),
      ),
  ).pipe(Command.withDescription(description))

const logsCommand = makeLogsCommand(
  "logs",
  "Show recent primary runtime logs",
  runLogs,
)

const canaryLogsCommand = makeLogsCommand(
  "canary-logs",
  "Show recent canary runtime logs",
  runCanaryLogs,
)

// MigrationError is caught here for user-friendly output, then
// re-thrown so the command exits non-zero. @effect/cli treats an
// unhandled tagged error as a silent exit(1).
const migrateCommand = Command.make("migrate", { orgPath }, ({ orgPath }) =>
  runMigrate(orgPath).pipe(
    Effect.catchTag("MigrationError", (error) =>
      Effect.gen(function* () {
        yield* Console.error(`\n❌ Migration failed: ${error.reason}`)
        if (error.statement) {
          yield* Console.error(`   Statement: ${error.statement}`)
        }
        return yield* error
      }),
    ),
  ),
).pipe(
  Command.withDescription(
    "Run system and org schema migrations (uses SQLITE_DATABASE_PATH or $org-path/db/pf.db)",
  ),
)

const migrateCustomCommand = Command.make(
  "migrate-custom",
  { orgPath },
  ({ orgPath }) => runMigrateCustom(orgPath),
).pipe(
  Command.withDescription(
    "Run custom schema migrations for organisation (uses SQLITE_DATABASE_PATH or $org-path/db/pf.db)",
  ),
)

const initCommand = Command.make(
  "init",
  { orgPath: initOrgPath, providers: initProviders, email: initEmail },
  ({ orgPath, providers, email }) => runInit(orgPath, providers, email),
).pipe(
  Command.withDescription(
    "Initialise a new organisation directory with template files and auth scaffolding",
  ),
)

const getFrontendJwtCommand = Command.make(
  "get-frontend-jwt",
  { orgPath: initOrgPath },
  ({ orgPath }) => runGetFrontendJwt(orgPath),
).pipe(
  Command.withDescription(
    "Output the stored frontend JWT token (created during import)",
  ),
)

const refreshFrontendJwtCommand = Command.make(
  "refresh-frontend-jwt",
  { orgPath: initOrgPath },
  ({ orgPath }) => runRefreshFrontendJwt(orgPath),
).pipe(
  Command.withDescription(
    "Regenerate the frontend JWT token with the current issuer URL and signing keys",
  ),
)

// Config commands options
const configProjectId = Options.text("project").pipe(
  Options.withDescription("Project number (or internal ID)"),
)

const configStageId = Options.text("stage").pipe(
  Options.withDescription("Stage name"),
)

const configKey = Args.text({ name: "key" }).pipe(
  Args.withDescription("Configuration parameter name"),
)

const configSetArgs = Args.repeated(Args.text({ name: "assignment" })).pipe(
  Args.withDescription("One of KEY, KEY=VALUE, or KEY VALUE"),
)

const configSecret = Options.boolean("secret").pipe(
  Options.withDefault(false),
  Options.withDescription("Store as a secret (SecureString in SSM)"),
)

const configFromStageId = Options.text("from-stage").pipe(
  Options.withDescription("Source stage name"),
)

const stageProjectId = Options.text("project").pipe(
  Options.withDescription("Project number (or internal ID)"),
)

const envProjectId = Options.text("project").pipe(
  Options.withDescription("Project number (or internal ID)"),
)

const envStageId = Options.text("stage").pipe(
  Options.withDescription("Stage name"),
)

const envListStageId = Options.text("stage").pipe(
  Options.optional,
  Options.withDescription("Stage name"),
)

const stageNameArg = Args.text({ name: "stage-name" }).pipe(
  Args.withDescription("Stage name to create"),
)

const envNameArg = Args.text({ name: "env-name" }).pipe(
  Args.withDescription("Environment name to create"),
)

// Config subcommands
const configListCommand = Command.make(
  "list",
  { projectId: configProjectId, stageId: configStageId },
  ({ projectId, stageId }) => runConfigList(projectId, stageId),
).pipe(
  Command.withDescription("List all config parameters for a project and stage"),
)

const configGetCommand = Command.make(
  "get",
  { projectId: configProjectId, stageId: configStageId, key: configKey },
  ({ projectId, stageId, key }) => runConfigGet(projectId, stageId, key),
).pipe(Command.withDescription("Get a config parameter value"))

const configSetCommand = Command.make(
  "set",
  {
    projectId: configProjectId,
    stageId: configStageId,
    args: configSetArgs,
    isSecret: configSecret,
  },
  ({ projectId, stageId, args, isSecret }) =>
    runConfigSet(projectId, stageId, args, isSecret),
).pipe(Command.withDescription("Set a config parameter value"))

const configDeleteCommand = Command.make(
  "delete",
  { projectId: configProjectId, stageId: configStageId, key: configKey },
  ({ projectId, stageId, key }) => runConfigDelete(projectId, stageId, key),
).pipe(Command.withDescription("Delete a config parameter"))

const configCopyNewCommand = Command.make(
  "copy-new",
  {
    projectId: configProjectId,
    stageId: configStageId,
    fromStageId: configFromStageId,
  },
  ({ projectId, stageId, fromStageId }) =>
    runConfigCopyNew(projectId, stageId, fromStageId),
).pipe(
  Command.withDescription(
    "Copy only missing config parameters from another stage",
  ),
)

const configCommand = Command.make("config", {}).pipe(
  Command.withDescription("Manage SSM configuration parameters"),
  Command.withSubcommands([
    configListCommand,
    configGetCommand,
    configSetCommand,
    configDeleteCommand,
    configCopyNewCommand,
  ]),
)

const stageAddCommand = Command.make(
  "add",
  { projectId: stageProjectId, stageName: stageNameArg },
  ({ projectId, stageName }) =>
    runStageAdd(projectId, stageName).pipe(
      Effect.catchTag("CliError", (error) =>
        Effect.gen(function* () {
          yield* Console.error(`\n❌ ${error.message}`)
          yield* Effect.sync(() => {
            process.exitCode = 1
          })
        }),
      ),
    ),
).pipe(Command.withDescription("Add a stage to a project"))

const stageListCommand = Command.make(
  "list",
  { projectId: stageProjectId },
  ({ projectId }) =>
    runStageList(projectId).pipe(
      Effect.catchTag("CliError", (error) =>
        Effect.gen(function* () {
          yield* Console.error(`\n❌ ${error.message}`)
          yield* Effect.sync(() => {
            process.exitCode = 1
          })
        }),
      ),
    ),
).pipe(Command.withDescription("List stages in a project"))

const stageCommand = Command.make("stage", {}).pipe(
  Command.withDescription("Manage project stages"),
  Command.withSubcommands([stageListCommand, stageAddCommand]),
)

const envAddCommand = Command.make(
  "add",
  { projectId: envProjectId, stageId: envStageId, environmentName: envNameArg },
  ({ projectId, stageId, environmentName }) =>
    runEnvAdd(projectId, stageId, environmentName).pipe(
      Effect.catchTag("CliError", (error) =>
        Effect.gen(function* () {
          yield* Console.error(`\n❌ ${error.message}`)
          yield* Effect.sync(() => {
            process.exitCode = 1
          })
        }),
      ),
    ),
).pipe(Command.withDescription("Add an environment to a stage"))

const envListCommand = Command.make(
  "list",
  { projectId: envProjectId, stageId: envListStageId },
  ({ projectId, stageId }) =>
    runEnvList(projectId, Option.getOrUndefined(stageId)).pipe(
      Effect.catchTag("CliError", (error) =>
        Effect.gen(function* () {
          yield* Console.error(`\n❌ ${error.message}`)
          yield* Effect.sync(() => {
            process.exitCode = 1
          })
        }),
      ),
    ),
).pipe(Command.withDescription("List environments in a project"))

const envCommand = Command.make("env", {}).pipe(
  Command.withDescription("Manage project environments"),
  Command.withSubcommands([envListCommand, envAddCommand]),
)

// Auth commands
const authLoginCommand = Command.make("login", {}, () =>
  Effect.gen(function* () {
    const baseUrl = yield* Config.string("BASE_URL").pipe(
      Config.withDefault("https://console.processfocus.com"),
    )
    const ciProviderUserOption = yield* Config.option(
      Config.string(HIDDEN_CI_PROVIDER_USER_ENV),
    )
    const ciProviderUser = Option.getOrUndefined(ciProviderUserOption)
    yield* runAuthLogin(
      baseUrl,
      ciProviderUser === undefined ? {} : { ciProviderUser },
    )
  }).pipe(
    Effect.catchTag("AuthLoginError", (error) =>
      Effect.gen(function* () {
        yield* Console.error(`\n❌ Login failed: ${error.message}`)
        yield* Effect.sync(() => {
          process.exitCode = 1
        })
      }),
    ),
  ),
).pipe(
  Command.withDescription(
    "Login via browser-based OAuth (uses BASE_URL env var, defaults to https://console.processfocus.com)",
  ),
)

const authCommand = Command.make("auth", {}).pipe(
  Command.withDescription("Authentication commands"),
  Command.withSubcommands([authLoginCommand]),
)

// Agent skills commands
const skillsListCommand = Command.make("list", {}, () => runSkillsList()).pipe(
  Command.withDescription("List agent skills served by this pfcli version"),
)

const skillsGetCommand = Command.make("get", { name: skillName }, ({ name }) =>
  runSkillsGet(name).pipe(
    Effect.catchTag("CliError", (error) =>
      Effect.gen(function* () {
        yield* Console.error(`\n❌ ${error.message}`)
        yield* Effect.sync(() => {
          process.exitCode = 1
        })
      }),
    ),
  ),
).pipe(Command.withDescription("Print an agent skill for this pfcli version"))

const skillsCommand = Command.make("skills", {}).pipe(
  Command.withDescription("Agent-oriented runtime skill guidance"),
  Command.withSubcommands([skillsListCommand, skillsGetCommand]),
)

// Grant commands options
const grantRoleOption = Options.text("role").pipe(
  Options.withDescription("Role path to grant (e.g. /Administrator)"),
)

const grantUserOption = Options.text("user").pipe(
  Options.withDescription("Email address of the provider user"),
)

const grantProjectId = Options.text("project").pipe(
  Options.optional,
  Options.withDescription("Project number or internal ID (remote mode)"),
)

const grantEnvironmentId = Options.text("env").pipe(
  Options.optional,
  Options.withDescription("Environment name (remote mode)"),
)

const grantOrgPath = Args.text({ name: "org-path" }).pipe(
  Args.optional,
  Args.withDescription("Path to the organisation directory (local mode only)"),
)

// Grant subcommands
const grantRoleCommand = Command.make(
  "role",
  {
    role: grantRoleOption,
    user: grantUserOption,
    projectId: grantProjectId,
    environmentId: grantEnvironmentId,
    orgPath: grantOrgPath,
  },
  ({ role, user, projectId, environmentId, orgPath }) => {
    const opts = {
      orgPath: Option.getOrUndefined(orgPath),
      rolePath: role,
      email: user,
      projectId: Option.getOrUndefined(projectId),
      environmentId: Option.getOrUndefined(environmentId),
    }
    return runGrantRole(opts)
  },
).pipe(
  Command.withDescription(
    "Grant a role to a provider user locally or in a remote customer environment",
  ),
)

const grantCommand = Command.make("grant", {}).pipe(
  Command.withDescription("Grant operations"),
  Command.withSubcommands([grantRoleCommand]),
)

const invitationProjectOptionName = "project"
const invitationEnvironmentOptionName = "env"
const invitationEmailOptionName = "email"

const invitationProjectId = Options.text(invitationProjectOptionName).pipe(
  Options.optional,
  Options.withDescription("Project number or internal ID (remote mode)"),
)

const invitationEnvironmentId = Options.text(
  invitationEnvironmentOptionName,
).pipe(
  Options.optional,
  Options.withDescription("Environment name (remote mode)"),
)

const invitationEmail = Options.text(invitationEmailOptionName).pipe(
  Options.optional,
  Options.withDescription(
    "Normalized Email of the Invitation or existing account",
  ),
)

const invitationRotate = Options.boolean("rotate").pipe(
  Options.withDefault(false),
  Options.withDescription(
    "Replace an active or expired Registration Link, or issue an existing account's Passkey Recovery Link",
  ),
)

const invitationOrgPath = Args.text({ name: "org-path" }).pipe(
  Args.optional,
  Args.withDescription("Path to the organisation directory (local mode only)"),
)

const invitationRegistrationLinkCommand = Command.make(
  "registration-link",
  {
    projectId: invitationProjectId,
    environmentId: invitationEnvironmentId,
    email: invitationEmail,
    rotate: invitationRotate,
    orgPath: invitationOrgPath,
  },
  ({ projectId, environmentId, email, rotate, orgPath }) =>
    runInvitationRegistrationLink({
      orgPath: Option.getOrUndefined(orgPath),
      projectId: Option.getOrUndefined(projectId),
      environmentId: Option.getOrUndefined(environmentId),
      email: Option.getOrUndefined(email),
      rotate,
    }),
).pipe(
  Command.withDescription(
    "Issue a Registration Link or, with --rotate, recover an existing account locally or remotely",
  ),
)

const invitationCommand = Command.make("invitation", {}).pipe(
  Command.withDescription("Invitation operations"),
  Command.withSubcommands([invitationRegistrationLinkCommand]),
)

// Main CLI
const app = Command.make("pfcli", {}).pipe(
  Command.withDescription("Process Focus CLI Tool"),
  Command.withSubcommands([
    initCommand,
    importCommand,
    buildCommand,
    projectsCommand,
    deployCommand,
    destroyCommand,
    logsCommand,
    canaryLogsCommand,
    dbCommand,
    customDomainCommand,
    migrateCommand,
    migrateCustomCommand,
    getFrontendJwtCommand,
    refreshFrontendJwtCommand,
    configCommand,
    stageCommand,
    envCommand,
    authCommand,
    skillsCommand,
    grantCommand,
    invitationCommand,
  ]),
)

const cli = Command.run(app, {
  name: "pfcli",
  version: CLI_PACKAGE_VERSION,
})

const formatCliHelpOutput = (value: unknown): unknown => {
  if (typeof value !== "string" || !value.includes("COMMANDS")) {
    return value
  }

  let inCommandsSection = false

  return value
    .split("\n")
    .map((line) => {
      if (line.includes("COMMANDS")) {
        inCommandsSection = true
        return line
      }

      if (inCommandsSection) {
        return line.replace(/^(\s*)- /, "$1")
      }

      return line
    })
    .join("\n")
}

const patchCliHelpOutput = () => {
  const originalLog = console.log
  const originalError = console.error

  console.log = (...args) =>
    originalLog(...args.map((arg) => formatCliHelpOutput(arg)))
  console.error = (...args) =>
    originalError(...args.map((arg) => formatCliHelpOutput(arg)))

  return () => {
    console.log = originalLog
    console.error = originalError
  }
}

const maybeShowConfigSubcommandHint = (argv: readonly string[]) => {
  const args = argv.slice(2)

  if (args[0] !== "config") {
    return
  }

  const nextArg = args[1]
  if (nextArg !== undefined && !nextArg.startsWith("-")) {
    return
  }

  console.error(
    "Missing config subcommand. Use one of: list, get, set, delete, copy-new",
  )
  console.error("Examples:")
  console.error(
    '  pfcli config list --project 0000-0000-0002 --stage "Development"',
  )
  console.error(
    '  pfcli config set --project 0000-0000-0002 --stage "Development" GOOGLE_CLIENT_ID="$GOOGLE_CLIENT_ID"',
  )
  console.error(
    '  pfcli config copy-new --project 0000-0000-0002 --stage "Production" --from-stage "Development"',
  )
}

type InvitationRegistrationLinkArgOrder =
  | {
      readonly ok: true
      readonly argv: string[]
    }
  | {
      readonly ok: false
      readonly error: string
    }

const invitationRegistrationLinkValueOptions = [
  `--${invitationProjectOptionName}`,
  `--${invitationEnvironmentOptionName}`,
  `--${invitationEmailOptionName}`,
]

const findMissingInvitationRegistrationLinkOptionValue = (
  args: readonly string[],
): string | undefined => {
  for (let index = 0; index < args.length; index++) {
    const option = args[index]
    if (
      option !== undefined &&
      invitationRegistrationLinkValueOptions.includes(option)
    ) {
      const value = args[index + 1]
      if (value === undefined || value.startsWith("-")) {
        return option
      }
      index++
    }
  }

  return undefined
}

const findInvitationRegistrationLinkOrgPathIndex = (
  args: readonly string[],
): number | undefined => {
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (argument === undefined) {
      continue
    }
    if (invitationRegistrationLinkValueOptions.includes(argument)) {
      index++
      continue
    }
    if (!argument.startsWith("-")) {
      return index
    }
  }

  return undefined
}

const normalizeInvitationRegistrationLinkArgOrder = (
  argv: readonly string[],
): InvitationRegistrationLinkArgOrder => {
  const invitationCommandIndex = 2
  const registrationLinkCommandIndex = 3

  if (
    argv[invitationCommandIndex] !== "invitation" ||
    argv[registrationLinkCommandIndex] !== "registration-link"
  ) {
    return { ok: true, argv: [...argv] }
  }

  const commandArgs = argv.slice(registrationLinkCommandIndex + 1)
  const missingValueOption =
    findMissingInvitationRegistrationLinkOptionValue(commandArgs)
  if (missingValueOption !== undefined) {
    return {
      ok: false,
      error: `${missingValueOption} requires a value.`,
    }
  }

  const orgPathIndex = findInvitationRegistrationLinkOrgPathIndex(commandArgs)
  if (orgPathIndex === undefined) {
    return { ok: true, argv: [...argv] }
  }

  const orgPath = commandArgs[orgPathIndex]
  if (orgPath === undefined) {
    return { ok: true, argv: [...argv] }
  }

  return {
    ok: true,
    argv: [
      ...argv.slice(0, registrationLinkCommandIndex + 1),
      ...commandArgs.slice(0, orgPathIndex),
      ...commandArgs.slice(orgPathIndex + 1),
      orgPath,
    ],
  }
}

export const runPfcliCommand = (argv: readonly string[]) =>
  Effect.scoped(
    Effect.acquireRelease(Effect.sync(patchCliHelpOutput), (restoreOutput) =>
      Effect.sync(restoreOutput),
    ).pipe(
      Effect.flatMap(() =>
        Effect.gen(function* () {
          const hiddenArgs = extractHiddenCiProviderUserArgs(argv)
          if (hiddenArgs.error) {
            yield* Console.error(`\n❌ ${hiddenArgs.error}`)
            yield* Effect.sync(() => {
              process.exitCode = 1
            })
            return
          }

          if (hiddenArgs.providerUser !== undefined) {
            // Hidden side-channel: @effect/cli should not know about this CI-only
            // flag, so full-entrypoint tests must restore this env var after use.
            process.env[HIDDEN_CI_PROVIDER_USER_ENV] = hiddenArgs.providerUser
          }

          const registrationLinkArgs =
            normalizeInvitationRegistrationLinkArgOrder(hiddenArgs.argv)
          if (!registrationLinkArgs.ok) {
            yield* Console.error(`\n❌ ${registrationLinkArgs.error}`)
            yield* Effect.sync(() => {
              process.exitCode = 1
            })
            return
          }

          yield* cli(registrationLinkArgs.argv)
        }).pipe(
          Effect.catchIf(ValidationError.isValidationError, (error) =>
            Effect.sync(() => {
              if (!ValidationError.isHelpRequested(error)) {
                maybeShowConfigSubcommandHint(argv)
              }
              process.exitCode = ValidationError.isHelpRequested(error) ? 0 : 1
            }),
          ),
        ),
      ),
    ),
  )

if (import.meta.main) {
  runPfcliCommand(process.argv).pipe(
    Effect.provide(NodeContext.layer),
    NodeRuntime.runMain,
  )
}
