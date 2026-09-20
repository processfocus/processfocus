import { and, eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import * as schema from "@pf/drizzle-sqlite"
import { FlowQueries } from "@pf/graphql-db-operations"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite"

/**
 * Live implementation of FlowQueries service for SQLite.
 */
export const SqliteFlowQueriesLive = Layer.effect(
  FlowQueries,
  Effect.gen(function* () {
    const db = yield* TypedSqliteDrizzle

    return {
      queryFlowsBySourceStepId: (stepId: string) =>
        db
          .select({
            id: schema.flow.id,
            sourceStepId: schema.flow.sourceStepId,
            targetStepId: schema.flow.targetStepId,
          })
          .from(schema.flow)
          .where(
            and(
              eq(schema.flow.sourceStepId, stepId),
              eq(schema.flow._deleted, false),
            ),
          ),
    }
  }),
)
