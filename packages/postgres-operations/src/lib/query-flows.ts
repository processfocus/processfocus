import { and, eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import * as schema from "@pf/drizzle-postgres"
import { FlowQueries } from "@pf/graphql-db-operations"
import { TypedPostgresDrizzle } from "@pf/service-drizzle-postgres"

/**
 * Live implementation of FlowQueries service for PostgreSQL.
 */
export const PostgresFlowQueriesLive = Layer.effect(
  FlowQueries,
  Effect.gen(function* () {
    const db = yield* TypedPostgresDrizzle

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
