import { randomUUID } from "node:crypto"
import { Console, Data, Effect, Layer, Result, Schema } from "effect"
import { SqlClient } from "effect/sql"
import {
  DATABASE_PATH_NOT_CONFIGURED,
  immediateTransactionRequested,
  isLocalFilePath,
  makeDatabaseConfigLayer,
  resolveDatabasePath,
} from "@pf/db-info"
import { Email } from "@pf/form-schema"
import { InvitationSource, SettingsQueries } from "@pf/graphql-db-operations"
import { TypedSqliteDrizzleLayer } from "@pf/service-drizzle-sqlite"
import { SqliteSettingsQueriesLive } from "@pf/sqlite-operations"
import { makePfcliSqlClientLayer } from "../utils/local-database-layer"

class InvitationCreateError extends Data.TaggedError("InvitationCreateError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export const runInvitationCreate = (options: {
  readonly orgPath?: string | undefined
  readonly databasePath?: string | undefined
  readonly email: string
  readonly roles: readonly string[]
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    const databasePath =
      options.databasePath ?? resolveDatabasePath(options.orgPath)
    if (!databasePath) {
      return yield* new InvitationCreateError({
        message: DATABASE_PATH_NOT_CONFIGURED,
      })
    }
    if (!isLocalFilePath(databasePath)) {
      return yield* new InvitationCreateError({
        message:
          "Invitation creation requires a local database file. Set SQLITE_DATABASE_PATH to a local file or supply org-path; remote databases are not supported.",
      })
    }
    const emailResult = Schema.decodeUnknownResult(Email)(options.email.trim())
    if (Result.isFailure(emailResult)) {
      return yield* new InvitationCreateError({
        message: "Enter a valid email address.",
      })
    }
    if (options.roles.length === 0) {
      return yield* new InvitationCreateError({
        message: "Supply at least one explicit --role path.",
      })
    }
    const email = emailResult.success.toLowerCase()
    const dbLayer = makePfcliSqlClientLayer(databasePath)
    const appLayer = SqliteSettingsQueriesLive.pipe(
      Layer.provideMerge(TypedSqliteDrizzleLayer),
      Layer.provideMerge(dbLayer),
      Layer.provide(makeDatabaseConfigLayer(databasePath)),
    )
    yield* Effect.gen(function* () {
      const settings = yield* SettingsQueries
      const sql = yield* SqlClient.SqlClient
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const roles = yield* settings.queryAllRoles()
            const byPath = new Map(roles.map((role) => [role.path, role.id]))
            const roleIds: string[] = []
            for (const path of new Set(options.roles)) {
              const id = byPath.get(path)
              if (!id) {
                return yield* new InvitationCreateError({
                  message: `Unknown role path: ${path}. Use an exact role path from the imported organisation.`,
                })
              }
              roleIds.push(id)
            }
            if (yield* settings.queryProviderUserByEmail(email)) {
              return yield* new InvitationCreateError({
                message:
                  "A user with this email already exists. Manage that user's roles instead of creating an invitation.",
              })
            }
            if (yield* settings.queryPendingInvitationByEmail(email)) {
              return yield* new InvitationCreateError({
                message: `A pending invitation already exists for: ${email}. Use invitation registration-link for its passkey Registration Link.`,
              })
            }
            const id = yield* settings.createInvitation({
              invitationId: randomUUID(),
              email,
              source: InvitationSource.Cli,
              createdBy: "SYSTEM",
              updatedBy: "SYSTEM",
            })
            yield* settings.replaceInvitationRoles(id, roleIds, "SYSTEM")
          }),
        )
        .pipe(Effect.provideService(immediateTransactionRequested, true))
    }).pipe(
      Effect.provide(appLayer),
      Effect.catchTags({
        SqlError: (cause) =>
          Effect.fail(
            new InvitationCreateError({
              message:
                "Could not create Invitation. Check the local database path, migrations and imported roles, and check for an existing pending Invitation before retrying.",
              cause,
            }),
          ),
        ConfigError: (cause) =>
          Effect.fail(
            new InvitationCreateError({
              message:
                "Could not open the local database. Check SQLITE_DATABASE_PATH or org-path.",
              cause,
            }),
          ),
      }),
    )
    yield* Console.log(`Created pending Invitation for ${email}.`)
  }).pipe(
    Effect.catchTag("InvitationCreateError", (error) =>
      Effect.gen(function* () {
        yield* Console.error(`❌ ${error.message}`)
        yield* Effect.sync(() => {
          process.exitCode = 1
        })
      }),
    ),
  )
