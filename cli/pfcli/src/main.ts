#!/usr/bin/env bun

import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { DATABASE_UPLOAD_MODES } from "@processfocus/hosting-contract"
import { Config, Console, Effect, Option } from "effect"
import { Argument, CliError as CliParseError, Command, Flag } from "effect/cli"
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
import { runDeploy, runDeployStatus } from "./commands/deploy"
import { runDestroy } from "./commands/destroy"
import { runEnvAdd } from "./commands/env/add"
import { runEnvList } from "./commands/env/list"
import { runGetFrontendJwt } from "./commands/get-frontend-jwt"
import { runGrantRole } from "./commands/grant-role"
import { runImport, runImportWatch } from "./commands/import"
import { SUPPORTED_PROVIDERS, runInit } from "./commands/init"
import { runInvitationCreate } from "./commands/invitation-create"
import { runInvitationRegistrationLink } from "./commands/invitation-registration-link"
import { runCanaryLogs, runLogs } from "./commands/logs"
import { runMigrate } from "./commands/migrate"
import { runMigrateCustom } from "./commands/migrate-custom"
import { runProjectCreate } from "./commands/project-create"
import { runProjects } from "./commands/projects"
import { runRefreshFrontendJwt } from "./commands/refresh-frontend-jwt"
import { runSkillsGet, runSkillsList } from "./commands/skills"
import { runStageAdd } from "./commands/stage/add"
import { runStageList } from "./commands/stage/list"
import {
  runWorkloadEnroll,
  runWorkloadList,
  runWorkloadRemove,
  runWorkloadSave,
} from "./commands/workload"
import {
  BuildError,
  CliError,
  type CustomDomainError,
  GraphqlSchemaError,
  PolicyFileError,
} from "./errors"
import { CLI_PACKAGE_VERSION } from "./package-metadata"
import { validateUrlOption } from "./utils/operator-inputs"
import { normalizeRollbackTimestamp } from "./utils/rollback-timestamp"

// Arguments
const orgPath = Argument.Directory("org-path").pipe(
  Argument.withDescription("Path to the organisation directory"),
)

const initOrgPath = Argument.Directory("org-path").pipe(
  Argument.withDescription("Path to the organisation directory (or PF_ORG)"),
  Argument.withFallbackConfig(Config.String("PF_ORG")),
)

// Options
const databasePath = Flag.String("database-path").pipe(
  Flag.optional,
  Flag.withDescription(
    "Database path (overrides SQLITE_DATABASE_PATH; not available with --project/--env)",
  ),
)

const issuerUrl = Flag.String("issuer-url").pipe(
  Flag.optional,
  Flag.withDescription("Frontend JWT issuer URL (overrides OAUTH_ISSUER_URL)"),
)

const frontendUrl = Flag.String("frontend-url").pipe(
  Flag.optional,
  Flag.withDescription(
    "Local link frontend HTTP(S) origin, including port (overrides frontend URL environment variables)",
  ),
)

// The build handler resolves relative output paths against the organisation.
const outputDir = Flag.String("output").pipe(
  Flag.withAlias("o"),
  Flag.withDefault("dist"),
  Flag.withDescription("Output directory for build artifacts"),
)

const projectId = Flag.String("project").pipe(
  Flag.optional,
  Flag.withDescription("Project number (or internal ID) to deploy"),
)

const environmentId = Flag.String("env").pipe(
  Flag.optional,
  Flag.withDescription("Environment name to deploy to"),
)

const logsProjectId = Flag.String("project").pipe(
  Flag.optional,
  Flag.withDescription(
    "Project number (or internal ID) whose runtime logs to read",
  ),
)

const logsEnvironmentId = Flag.String("env").pipe(
  Flag.optional,
  Flag.withDescription("Environment name whose runtime logs to read"),
)

const noWait = Flag.Boolean("no-wait").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Return after starting the deployment without waiting"),
)

const importWatch = Flag.Boolean("watch").pipe(
  Flag.withDefault(false),
  Flag.withDescription(
    "Run an experimental watched import loop with debounce, timing and recovery",
  ),
)

const importWatchSkipInitial = Flag.Boolean("watch-skip-initial").pipe(
  Flag.withDefault(false),
  Flag.withDescription(
    "Start watch mode without its initial import after a separate bootstrap import has completed",
  ),
)

const customDomainProjectId = Flag.String("project").pipe(
  Flag.withDescription("Project number or internal ID"),
)

const customDomainEnvironmentId = Flag.String("env").pipe(
  Flag.withDescription("Environment name"),
)

const rollbackProjectId = Flag.String("project").pipe(
  Flag.optional,
  Flag.withDescription("Project number (or internal ID) to roll back"),
)

const rollbackEnvironmentId = Flag.String("env").pipe(
  Flag.optional,
  Flag.withDescription("Environment name to roll back"),
)

const rollbackTimestamp = Flag.String("timestamp").pipe(
  Flag.optional,
  Flag.withDescription(
    "RFC3339 / ISO-8601 rollback timestamp; if no timezone is supplied, the local terminal timezone is used (for example 2026-04-16T18:00:00)",
  ),
)

const rollbackNoWait = Flag.Boolean("no-wait").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Return after starting the rollback without waiting"),
)

const destroyProjectId = Flag.String("project").pipe(
  Flag.optional,
  Flag.withDescription("Project number (or internal ID) to destroy from"),
)

const destroyEnvironmentId = Flag.String("env").pipe(
  Flag.optional,
  Flag.withDescription("Environment name (or internal ID) to destroy"),
)

const destroyConfirmed = Flag.Boolean("yes").pipe(
  Flag.withDefault(false),
  Flag.withDescription(
    "Confirm deletion of the environment's AWS stacks and environment record",
  ),
)

const destroyNoWait = Flag.Boolean("no-wait").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Return after starting destruction without waiting"),
)

const downloadProjectId = Flag.String("project").pipe(
  Flag.optional,
  Flag.withDescription("Project number (or internal ID) to download from"),
)

const downloadEnvironmentId = Flag.String("env").pipe(
  Flag.optional,
  Flag.withDescription("Environment name to download from"),
)

const downloadOutputPath = Flag.String("output").pipe(
  Flag.optional,
  Flag.withDescription("Output SQLite file path"),
)

const shellProjectId = Flag.String("project").pipe(
  // Keep this optional so --project and --env can be reported together.
  Flag.optional,
  Flag.withDescription(
    "Project number (or internal ID) to open a database shell for",
  ),
)

const shellEnvironmentId = Flag.String("env").pipe(
  // Keep this optional so --project and --env can be reported together.
  Flag.optional,
  Flag.withDescription("Environment name to open a database shell for"),
)

const shellTtl = Flag.String("ttl").pipe(
  Flag.optional,
  Flag.withDescription(
    'Database Shell session TTL; bare numbers are seconds, for example "900", "15m", or "1h"',
  ),
)

const uploadProjectId = Flag.String("project").pipe(
  Flag.optional,
  Flag.withDescription("Project number (or internal ID) to upload to"),
)

const uploadEnvironmentId = Flag.String("env").pipe(
  Flag.optional,
  Flag.withDescription("Environment name to upload to"),
)

const uploadMode = Flag.Literals("mode", [...DATABASE_UPLOAD_MODES]).pipe(
  Flag.withDefault("data-copy"),
  Flag.withDescription(
    "Upload mode: preserve destination authentication identity (data-copy) or restore all database state (exact-restore)",
  ),
)

const uploadSqliteFile = Argument.String("sqlite-file").pipe(
  // Keep this optional so missing options and the missing positional file can
  // be reported together using the same concise pfcli error style.
  Argument.optional,
  Argument.withDescription("Local SQLite database file to upload"),
)

const initProviders = Flag.Literals("identity-provider", [
  ...SUPPORTED_PROVIDERS,
]).pipe(
  Flag.atLeast(0),
  Flag.withDescription(
    `Identity provider to scaffold (repeatable: ${SUPPORTED_PROVIDERS.join(", ")})`,
  ),
)

const initEmail = Flag.String("email").pipe(
  Flag.withDescription(
    "Admin email used for the scaffolded invitation and Cedar policy",
  ),
)

const skillName = Argument.String("name").pipe(
  Argument.withDescription("Skill name to print"),
)

// Commands
const reportOperatorInputError = (error: CliError) =>
  Effect.gen(function* () {
    yield* Console.error(`\n❌ ${error.message}`)
    process.exitCode = 1
  })

const importCommand = Command.make(
  "import",
  {
    orgPath: initOrgPath,
    watch: importWatch,
    watchSkipInitial: importWatchSkipInitial,
    databasePath,
    issuerUrl,
  },
  ({ orgPath, watch, watchSkipInitial, databasePath, issuerUrl }) =>
    Effect.gen(function* () {
      const options = {
        databasePath: Option.getOrUndefined(databasePath),
        issuerUrl: Option.isSome(issuerUrl)
          ? yield* validateUrlOption(issuerUrl.value, "--issuer-url")
          : undefined,
      }
      if (watch) {
        return yield* runImportWatch(orgPath, {
          ...options,
          skipInitialImport: watchSkipInitial,
        })
      }
      if (watchSkipInitial) {
        yield* Console.warn(
          "--watch-skip-initial is ignored unless --watch is also set",
        )
      }
      return yield* runImport(orgPath, options)
    }).pipe(
      Effect.catchIf(
        (error: unknown): error is CliError => error instanceof CliError,
        reportOperatorInputError,
      ),
    ),
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

const workloadCommand = Command.make("workload").pipe(
  Command.withDescription(
    "Manage OIDC federation registrations for GitHub Actions",
  ),
  Command.withSubcommands([
    Command.make(
      "list",
      {
        project: Flag.String("project"),
        clientId: Flag.String("client-id").pipe(Flag.optional),
      },
      ({ project, clientId }) =>
        runWorkloadList(project, Option.getOrUndefined(clientId)),
    ),
    Command.make(
      "save",
      {
        project: Flag.String("project"),
        clientId: Flag.String("client-id").pipe(Flag.optional),
        name: Flag.String("name"),
        repository: Flag.String("repository"),
        branch: Flag.String("branch"),
        workflow: Flag.String("workflow"),
        environment: Flag.String("environment").pipe(
          Flag.optional,
          Flag.withDescription(
            "GitHub Environment name; omit for jobs without an environment (also clears the setting on edits)",
          ),
        ),
        permissions: Flag.String("permissions").pipe(
          Flag.withDescription(
            "Comma-separated deploy,create-environment,destroy-environment,database-download,database-upload",
          ),
        ),
        disabled: Flag.Boolean("disabled").pipe(Flag.withDefault(false)),
        events: Flag.String("events").pipe(
          Flag.withDefault("push,workflow_dispatch"),
        ),
      },
      ({
        project,
        clientId,
        environment,
        permissions,
        events,
        disabled,
        ...input
      }) =>
        runWorkloadSave(project, Option.getOrUndefined(clientId), {
          ...input,
          environment: Option.getOrUndefined(environment),
          permissions: permissions.split(","),
          events: events.split(","),
          enabled: !disabled,
        }),
    ),
    Command.make(
      "remove",
      { project: Flag.String("project"), clientId: Flag.String("client-id") },
      ({ project, clientId }) => runWorkloadRemove(project, clientId),
    ),
    Command.make("enroll", {}, () => runWorkloadEnroll()).pipe(
      Command.withDescription("Enroll federated identity"),
    ),
  ]),
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

const projectCommand = Command.make("project", {}).pipe(
  Command.withDescription("Manage projects"),
  Command.withSubcommands([
    Command.make(
      "create",
      { name: Flag.String("name"), region: Flag.String("region") },
      (input) =>
        runProjectCreate(input).pipe(
          Effect.catchTag("CliError", (error) =>
            Effect.gen(function* () {
              yield* Console.error(error.message)
              process.exitCode = 1
            }),
          ),
        ),
    ).pipe(
      Command.withDescription(
        "Create a project and wait for its project-number receipt",
      ),
    ),
  ]),
)

const executionId = Flag.String("execution-id").pipe(
  Flag.withDescription(
    "Persisted execution identity for automation receipt reconciliation",
  ),
  Flag.optional,
)

const deployStatusCommand = Command.make(
  "status",
  {
    project: Flag.String("project"),
    env: Flag.String("env"),
  },
  ({ project, env }) =>
    runDeployStatus(project, env).pipe(
      Effect.catchTag("CliError", (error) =>
        Effect.gen(function* () {
          yield* Console.error(`\n❌ ${error.message}`)
          process.exitCode = 1
        }),
      ),
    ),
).pipe(
  Command.withDescription(
    "Check the active Backend deployment without starting one",
  ),
)

const deployCommand = Command.make(
  "deploy",
  {
    orgPath,
    projectId,
    environmentId,
    noWait,
    executionId,
    waitTimeoutMs: Flag.Int("wait-timeout-ms").pipe(
      Flag.optional,
      Flag.withDescription(
        "Positive deployment inactivity timeout in milliseconds (overrides PFCLI_DEPLOY_WAIT_TIMEOUT_MS; incompatible with --no-wait)",
      ),
    ),
  },
  ({ orgPath, projectId, environmentId, noWait, executionId, waitTimeoutMs }) =>
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
          waitTimeoutMs: Option.getOrUndefined(waitTimeoutMs),
          executionId: Option.getOrUndefined(executionId),
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
    "Build and deploy an organisation. Ctrl-C stops waiting, not deployment. Use deploy status before retrying.",
  ),
  Command.withSubcommands([deployStatusCommand]),
)

const destroyCommand = Command.make(
  "destroy",
  {
    projectId: destroyProjectId,
    environmentId: destroyEnvironmentId,
    confirmed: destroyConfirmed,
    noWait: destroyNoWait,
    executionId,
  },
  ({ projectId, environmentId, confirmed, noWait, executionId }) =>
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
        executionId: Option.getOrUndefined(executionId),
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

// Print the migration-specific message before propagating the failure
// so the command exits non-zero.
const migrateCommand = Command.make(
  "migrate",
  { orgPath, databasePath },
  ({ orgPath, databasePath }) =>
    runMigrate(orgPath, {
      databasePath: Option.getOrUndefined(databasePath),
    }).pipe(
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
  { orgPath, databasePath },
  ({ orgPath, databasePath }) =>
    runMigrateCustom(orgPath, {
      databasePath: Option.getOrUndefined(databasePath),
    }),
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
  { orgPath: initOrgPath, databasePath },
  ({ orgPath, databasePath }) =>
    runGetFrontendJwt(orgPath, {
      databasePath: Option.getOrUndefined(databasePath),
    }),
).pipe(
  Command.withDescription(
    "Output the stored frontend JWT token (created during import)",
  ),
)

const refreshFrontendJwtCommand = Command.make(
  "refresh-frontend-jwt",
  { orgPath: initOrgPath, databasePath, issuerUrl },
  ({ orgPath, databasePath, issuerUrl }) =>
    runRefreshFrontendJwt(
      orgPath,
      {},
      {
        databasePath: Option.getOrUndefined(databasePath),
        issuerUrl: Option.getOrUndefined(issuerUrl),
      },
    ).pipe(Effect.catchTag("CliError", reportOperatorInputError)),
).pipe(
  Command.withDescription(
    "Regenerate the frontend JWT token with the current issuer URL and signing keys",
  ),
)

// Config commands options
const configProjectId = Flag.String("project").pipe(
  Flag.withDescription("Project number (or internal ID)"),
)

const configStageId = Flag.String("stage").pipe(
  Flag.withDescription("Stage name"),
)

const configKey = Argument.String("key").pipe(
  Argument.withDescription("Configuration parameter name"),
)

const configSetArgs = Argument.String("assignment")
  .pipe(Argument.variadic())
  .pipe(Argument.withDescription("One of KEY, KEY=VALUE, or KEY VALUE"))

const configSecret = Flag.Boolean("secret").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Store as a secret (SecureString in SSM)"),
)

const configFromStageId = Flag.String("from-stage").pipe(
  Flag.withDescription("Source stage name"),
)

const stageProjectId = Flag.String("project").pipe(
  Flag.withDescription("Project number (or internal ID)"),
)

const envProjectId = Flag.String("project").pipe(
  Flag.withDescription("Project number (or internal ID)"),
)

const envStageId = Flag.String("stage").pipe(Flag.withDescription("Stage name"))

const envListStageId = Flag.String("stage").pipe(
  Flag.optional,
  Flag.withDescription("Stage name"),
)

const stageNameArg = Argument.String("stage-name").pipe(
  Argument.withDescription("Stage name to create"),
)

const envNameArg = Argument.String("env-name").pipe(
  Argument.withDescription("Environment name to create"),
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
const authLoginCommand = Command.make(
  "login",
  {
    baseUrl: Flag.String("base-url").pipe(
      Flag.optional,
      Flag.withDescription("Console HTTP(S) origin (overrides BASE_URL)"),
    ),
  },
  ({ baseUrl: explicitBaseUrl }) =>
    Effect.gen(function* () {
      if (Option.isSome(explicitBaseUrl) && process.env["PFCLI_AUTH_MODE"]) {
        return yield* new CliError({
          message:
            "--base-url is not available in OIDC federation auth mode; use its configured endpoint.",
        })
      }
      const baseUrl = Option.isSome(explicitBaseUrl)
        ? yield* validateUrlOption(explicitBaseUrl.value, "--base-url", true)
        : yield* Config.String("BASE_URL").pipe(
            Config.withDefault("https://console.processfocus.com"),
          )
      yield* runAuthLogin(baseUrl)
    }).pipe(
      Effect.catchTag("CliError", reportOperatorInputError),
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
const grantRoleOption = Flag.String("role").pipe(
  Flag.withDescription("Role path to grant (e.g. /Administrator)"),
)

const grantUserOption = Flag.String("user").pipe(
  Flag.withDescription("Email address of the provider user"),
)

const grantProjectId = Flag.String("project").pipe(
  Flag.optional,
  Flag.withDescription("Project number or internal ID (remote mode)"),
)

const grantEnvironmentId = Flag.String("env").pipe(
  Flag.optional,
  Flag.withDescription("Environment name (remote mode)"),
)

const grantOrgPath = Argument.String("org-path").pipe(
  Argument.optional,
  Argument.withDescription(
    "Path to the organisation directory (local mode only)",
  ),
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
    databasePath,
  },
  ({ role, user, projectId, environmentId, orgPath, databasePath }) => {
    const opts = {
      databasePath: Option.getOrUndefined(databasePath),
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

const invitationProjectId = Flag.String(invitationProjectOptionName).pipe(
  Flag.optional,
  Flag.withDescription("Project number or internal ID (remote mode)"),
)

const invitationEnvironmentId = Flag.String(
  invitationEnvironmentOptionName,
).pipe(Flag.optional, Flag.withDescription("Environment name (remote mode)"))

const invitationEmail = Flag.String(invitationEmailOptionName).pipe(
  Flag.optional,
  Flag.withDescription(
    "Normalized Email of the Invitation or existing account",
  ),
)

const invitationRotate = Flag.Boolean("rotate").pipe(
  Flag.withDefault(false),
  Flag.withDescription(
    "Replace an active or expired Registration Link, or issue an existing account's Passkey Recovery Link",
  ),
)

const invitationOrgPath = Argument.String("org-path").pipe(
  Argument.optional,
  Argument.withDescription(
    "Path to the organisation directory (local mode only)",
  ),
)

const invitationRegistrationLinkCommand = Command.make(
  "registration-link",
  {
    projectId: invitationProjectId,
    environmentId: invitationEnvironmentId,
    email: invitationEmail,
    rotate: invitationRotate,
    orgPath: invitationOrgPath,
    databasePath,
    frontendUrl,
  },
  ({
    projectId,
    environmentId,
    email,
    rotate,
    orgPath,
    databasePath,
    frontendUrl,
  }) =>
    runInvitationRegistrationLink({
      databasePath: Option.getOrUndefined(databasePath),
      frontendUrl: Option.getOrUndefined(frontendUrl),
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

const invitationCreateCommand = Command.make(
  "create",
  {
    orgPath: invitationOrgPath,
    databasePath,
    email: Flag.String("email").pipe(
      Flag.withDescription("Invitee email address"),
    ),
    roles: Flag.String("role").pipe(
      Flag.atLeast(1),
      Flag.withDescription("Exact role path; repeat for multiple roles"),
    ),
  },
  ({ orgPath, email, roles, databasePath }) =>
    runInvitationCreate({
      databasePath: Option.getOrUndefined(databasePath),
      orgPath: Option.getOrUndefined(orgPath),
      email,
      roles,
    }),
).pipe(
  Command.withDescription(
    "Create a pending Invitation directly in a local organisation database",
  ),
)

const invitationCommand = Command.make("invitation", {}).pipe(
  Command.withDescription("Invitation operations"),
  Command.withSubcommands([
    invitationCreateCommand,
    invitationRegistrationLinkCommand,
  ]),
)

// Main CLI
export const pfcliCommand = Command.make("pfcli", {}).pipe(
  Command.withDescription("Process Focus CLI Tool"),
  Command.withSubcommands([
    initCommand,
    importCommand,
    buildCommand,
    projectsCommand,
    projectCommand,
    workloadCommand,
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

const cli = Command.runWith(pfcliCommand, {
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
  "--role",
  "--frontend-url",
  "--database-path",
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
    (argv[registrationLinkCommandIndex] !== "registration-link" &&
      argv[registrationLinkCommandIndex] !== "create")
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
          const registrationLinkArgs =
            normalizeInvitationRegistrationLinkArgOrder(argv)
          if (!registrationLinkArgs.ok) {
            yield* Console.error(`\n❌ ${registrationLinkArgs.error}`)
            yield* Effect.sync(() => {
              process.exitCode = 1
            })
            return
          }

          yield* cli(registrationLinkArgs.argv.slice(2))
        }).pipe(
          Effect.catchIf(CliParseError.isCliError, (error) =>
            Effect.sync(() => {
              if (!(error._tag === "ShowHelp" && error.errors.length === 0)) {
                maybeShowConfigSubcommandHint(argv)
              }
              process.exitCode =
                error._tag === "ShowHelp" && error.errors.length === 0 ? 0 : 1
            }),
          ),
        ),
      ),
    ),
  )

if (import.meta.main) {
  runPfcliCommand(process.argv).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  )
}
