import { Clock, Context, Data, Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { Audit, AuditPersistence, makeAudit } from "./lib/audit.js"

class AuditDeliveryTimeout extends Data.TaggedError("AuditDeliveryTimeout") {}

export const LocalAuditLive = Layer.effect(
  Audit,
  Effect.gen(function* () {
    const persistence = yield* AuditPersistence
    const sql = yield* SqlClient.SqlClient
    return makeAudit((event) =>
      Effect.gen(function* () {
        const started = yield* Clock.currentTimeMillis
        const checkBudget = Effect.gen(function* () {
          if ((yield* Clock.currentTimeMillis) - started >= 250)
            return yield* new AuditDeliveryTimeout()
        })
        // The embedded driver's promises cannot be cancelled. Drain the short independent
        // transaction before returning, including on timeout; never detach native writes.
        // This layer must receive the audit-specific short-lock/query database layer.
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* checkBudget
              yield* persistence.insert(event)
              // Native work may monopolize the JS thread, delaying the timeout timer.
              // Check elapsed time before COMMIT as well, rolling back late writes.
              yield* checkBudget
            }),
          )
          .pipe(
            // Some adapters share a transaction key across client instances.
            // The audit connection must not join a caller's transaction/savepoint.
            Effect.updateContext((context: Context.Context<never>) =>
              Context.omit(sql.transactionService)(context),
            ),
            Effect.uninterruptible,
          )
      }),
    )
  }),
)
