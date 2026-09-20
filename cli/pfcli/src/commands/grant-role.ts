import { Console, Data, Effect, Layer } from "effect"
import {
  DATABASE_PATH_NOT_CONFIGURED,
  makeDatabaseConfigLayer,
  resolveDatabasePath,
} from "@pf/db-info"
import {
  type GrantRoleGraphqlOutcome,
  type GrantRoleOutcome,
  PROVIDER_USER_NOT_FOUND_ERROR,
  fromGrantRoleGraphqlOutcome,
  grantRoleToProviderUser,
} from "@pf/graphql-db-operations"
import { TypedSqliteDrizzleLayer } from "@pf/service-drizzle-sqlite"
import { SqliteSettingsQueriesLive } from "@pf/sqlite-operations"
import type { CliError } from "../errors"
import { graphqlRequestWithCredentials } from "../utils/graphql-client"
import { makePfcliSqlClientLayer } from "../utils/local-database-layer"
import { ensureKnownEnvironmentName } from "../utils/remote-name-validation"

class GrantRoleDbPathError extends Data.TaggedError("GrantRoleDbPathError")<{
  readonly message: string
}> {}

class GrantRoleModeError extends Data.TaggedError("GrantRoleModeError")<{
  readonly message: string
}> {}

const REMOTE_GRANT_ROLE_TIMEOUT_MS = 30_000

const GRANT_PROJECT_USER_ROLE_MUTATION = `
  mutation GrantProjectUserRole($projectId: String!, $environmentId: String!, $rolePath: String!, $email: String!) {
    grantProjectUserRole(projectId: $projectId, environmentId: $environmentId, rolePath: $rolePath, email: $email) {
      success
      email
      rolePath
      alreadyHadRole
      error
    }
  }
`

interface GrantProjectUserRoleResponse {
  readonly grantProjectUserRole: GrantRoleGraphqlOutcome
}

const reportGrantRoleOutcome = (result: GrantRoleOutcome) =>
  Effect.gen(function* () {
    if (!result.success) {
      const subject =
        result.error === PROVIDER_USER_NOT_FOUND_ERROR
          ? result.email
          : result.rolePath

      yield* Console.error(`❌ ${result.error}: ${subject}`)
      yield* Effect.sync(() => {
        process.exitCode = 1
      })
      return
    }

    if (result.alreadyHadRole) {
      yield* Console.log(
        `already had role: ${result.email} already has ${result.rolePath}`,
      )
      return
    }

    yield* Console.log(
      `granted role: ${result.email} granted ${result.rolePath}`,
    )
  })

const grantRoleLocal = (options: {
  readonly orgPath?: string | undefined
  readonly rolePath: string
  readonly email: string
}) =>
  Effect.gen(function* () {
    const databasePath = resolveDatabasePath(options.orgPath)

    if (!databasePath) {
      return yield* new GrantRoleDbPathError({
        message: DATABASE_PATH_NOT_CONFIGURED,
      })
    }

    const dbLayer = makePfcliSqlClientLayer(databasePath)

    const appLayer = SqliteSettingsQueriesLive.pipe(
      Layer.provideMerge(TypedSqliteDrizzleLayer),
      Layer.provideMerge(dbLayer),
      Layer.provide(makeDatabaseConfigLayer(databasePath)),
    )

    const result = yield* grantRoleToProviderUser({
      rolePath: options.rolePath,
      email: options.email,
      grantedBy: "SYSTEM",
    }).pipe(Effect.provide(appLayer))

    yield* reportGrantRoleOutcome(result)
  })

const grantRoleRemote = (options: {
  readonly projectId: string
  readonly environmentId: string
  readonly rolePath: string
  readonly email: string
}) =>
  Effect.gen(function* () {
    const response =
      yield* graphqlRequestWithCredentials<GrantProjectUserRoleResponse>(
        GRANT_PROJECT_USER_ROLE_MUTATION,
        {
          projectId: options.projectId,
          environmentId: options.environmentId,
          rolePath: options.rolePath,
          email: options.email,
        },
        { timeoutMs: REMOTE_GRANT_ROLE_TIMEOUT_MS },
      )

    yield* reportGrantRoleOutcome(
      fromGrantRoleGraphqlOutcome(response.grantProjectUserRole),
    )
  })

const grantRole = (options: {
  readonly orgPath?: string | undefined
  readonly rolePath: string
  readonly email: string
  readonly projectId?: string | undefined
  readonly environmentId?: string | undefined
}) =>
  Effect.gen(function* () {
    const { projectId, environmentId } = options

    if (Boolean(projectId) !== Boolean(environmentId)) {
      return yield* new GrantRoleModeError({
        message: "Remote mode requires both --project and --env together.",
      })
    } else if (projectId && environmentId) {
      if (options.orgPath) {
        return yield* new GrantRoleModeError({
          message:
            "Remote mode does not accept positional org-path. Remove org-path when using --project/--env.",
        })
      }

      yield* ensureKnownEnvironmentName(projectId, environmentId)

      return yield* grantRoleRemote({
        projectId,
        environmentId,
        rolePath: options.rolePath,
        email: options.email,
      })
    }

    return yield* grantRoleLocal(options)
  })

export const runGrantRole = (options: {
  readonly orgPath?: string | undefined
  readonly rolePath: string
  readonly email: string
  readonly projectId?: string | undefined
  readonly environmentId?: string | undefined
}) =>
  grantRole(options).pipe(
    Effect.catchTag("GrantRoleModeError", (error) =>
      Effect.gen(function* () {
        yield* Console.error(`\n❌ ${error.message}`)
        yield* Effect.sync(() => {
          process.exitCode = 1
        })
      }),
    ),
    Effect.catchTag("GrantRoleDbPathError", (error) =>
      Effect.gen(function* () {
        yield* Console.error(`\n❌ ${error.message}`)
        yield* Effect.sync(() => {
          process.exitCode = 1
        })
      }),
    ),
    Effect.catchTag("CliError", (error: CliError) =>
      Effect.gen(function* () {
        yield* Console.error(`\n❌ ${error.message}`)
        yield* Effect.sync(() => {
          process.exitCode = 1
        })
      }),
    ),
    Effect.catchAll((error) =>
      Effect.gen(function* () {
        yield* Console.error(`\n❌ Grant role failed: ${String(error)}`)
        yield* Effect.sync(() => {
          process.exitCode = 1
        })
      }),
    ),
  )
