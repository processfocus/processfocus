import { eq, sql } from "drizzle-orm"
import { Effect, Layer, Option } from "effect"
import { permittedClientEmail, permittedClientRole } from "@pf/drizzle-postgres"
import {
  OAuthClientQueries,
  type OAuthClientRow,
} from "@pf/graphql-db-operations"
import { TypedPostgresDrizzle } from "@pf/service-drizzle-postgres"

/**
 * Postgres implementation of OAuthClientQueries service
 */
export const PostgresOAuthClientQueriesLive = Layer.effect(
  OAuthClientQueries,
  Effect.gen(function* () {
    const db = yield* TypedPostgresDrizzle

    return {
      queryOAuthClientByClientId: (clientId: string) =>
        Effect.gen(function* () {
          const results = yield* db.query.oauthClient.findMany({
            where: { clientId, _deleted: false },
          })
          if (results.length && results[0]) {
            const result = results[0]
            const row: OAuthClientRow = {
              id: result.id,
              clientId: result.clientId,
            }
            return Option.some(row)
          }
          return Option.none()
        }),

      /**
       * Set a permitted client role for an OAuth client.
       * Upserts to the permitted_client_role table.
       */
      addPermittedClientRole: (oauthClientId: string, roleId: string) =>
        db
          .insert(permittedClientRole)
          .values({
            oauthClientId,
            roleId,
          })
          .onConflictDoUpdate({
            target: [
              permittedClientRole.oauthClientId,
              permittedClientRole.roleId,
            ],
            targetWhere: eq(permittedClientRole._deleted, false),
            set: { updatedAt: sql`now()` },
          }),

      /**
       * Set a permitted provider user email for an OAuth client.
       * Upserts to the permitted_client_email table.
       */
      addPermittedClientEmail: (oauthClientId: string, email: string) =>
        db
          .insert(permittedClientEmail)
          .values({
            oauthClientId,
            email,
          })
          .onConflictDoUpdate({
            target: [
              permittedClientEmail.oauthClientId,
              permittedClientEmail.email,
            ],
            targetWhere: eq(permittedClientEmail._deleted, false),
            set: { updatedAt: sql`now()` },
          }),
    }
  }),
)
