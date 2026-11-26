import { DateTime, Effect, Layer } from "effect"
import { AuditPersistence } from "@pf/audit"
import { auditEvent } from "@pf/drizzle-postgres"
import { TypedPostgresDrizzle } from "@pf/service-drizzle-postgres"

export const PostgresAuditPersistenceLive = Layer.effect(
  AuditPersistence,
  Effect.gen(function* () {
    const db = yield* TypedPostgresDrizzle
    return {
      insert: (event) =>
        db
          .insert(auditEvent)
          .values({
            id: event.id,
            auditKind: event.action.type,
            occurredAt: DateTime.makeUnsafe(event.occurredAt),
            auditDetails: event.action.details,
            createdAt: DateTime.makeUnsafe(event.occurredAt),
            updatedAt: DateTime.makeUnsafe(event.occurredAt),
            createdBy: "SYSTEM",
            updatedBy: "SYSTEM",
          })
          .onConflictDoNothing({ target: auditEvent.id })
          .pipe(Effect.asVoid),
    }
  }),
)
