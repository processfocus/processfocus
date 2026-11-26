import { and, eq, lt, sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import * as schema from "@pf/drizzle-postgres"
import { AwsRoleProofStore } from "@pf/graphql-db-operations"
import { TypedPostgresDrizzle } from "@pf/service-drizzle-postgres"

export const PostgresAwsRoleProofStoreLive = Layer.effect(
  AwsRoleProofStore,
  Effect.gen(function* () {
    const db = yield* TypedPostgresDrizzle
    return AwsRoleProofStore.of({
      clients: db
        .select({
          clientId: schema.oauthClient.clientId,
          bindings: schema.oauthClient.awsRoleBindings,
        })
        .from(schema.oauthClient)
        .where(
          and(
            eq(schema.oauthClient._deleted, false),
            eq(schema.oauthClient.audience, "graphql-api"),
          ),
        ),
      consume: (key, expiresAt) =>
        db
          .insert(schema.oauthStorage)
          .values({
            oauthKey: key,
            keyKind: "aws-role-proof",
            keyValue: sql`'{}'::jsonb`,
            keyExpiry: expiresAt,
          })
          .onConflictDoNothing({ target: schema.oauthStorage.oauthKey })
          .returning({ id: schema.oauthStorage.id })
          .pipe(Effect.map((rows) => rows.length === 1)),
      cleanup: (now) =>
        db
          .delete(schema.oauthStorage)
          .where(
            and(
              eq(schema.oauthStorage.keyKind, "aws-role-proof"),
              lt(schema.oauthStorage.keyExpiry, now),
            ),
          )
          .pipe(Effect.asVoid),
    })
  }),
)
