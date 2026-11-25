import { sql } from "drizzle-orm"
import { Effect } from "effect"
import * as schema from "@pf/drizzle-sqlite"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite"

// Also used by the reproducible query-plan/scaling investigation.
export const seedProcessQueries = (unrelatedCount: number) =>
  Effect.gen(function* () {
    const db = yield* TypedSqliteDrizzle
    yield* db.insert(schema.orgUnit).values({
      id: "ou-query",
      name: "Query organisation",
      path: "/query",
      orgUnitLevel: "organisation",
    })
    for (const id of [
      "prc-target",
      "prc-idle",
      "prc-no-start",
      "prc-deleted",
      ...Array.from({ length: unrelatedCount }, (_, i) => `prc-other-${i}`),
    ]) {
      yield* db.insert(schema.process).values({
        id,
        name: id,
        path: `/${id}`,
        purpose: "Query fixture",
        orgUnitId: "ou-query",
        updatedAt: sql`julianday('2026-10-01')`,
        _deleted: id === "prc-deleted",
      })
      if (id === "prc-no-start") continue
      yield* db.insert(schema.step).values(
        ["start", "next", "end", "deleted"].map((suffix) => ({
          id: `${id}-${suffix}`,
          name: suffix,
          path: `/${id}/${suffix}`,
          purpose: suffix,
          processId: id,
          formFields: suffix === "start" ? 3 : null,
          _deleted: suffix === "deleted",
        })),
      )
      yield* db.insert(schema.flow).values(
        [
          { suffix: "next", source: "start", target: "next", deleted: false },
          { suffix: "end", source: "next", target: "end", deleted: false },
          { suffix: "deleted", source: "end", target: "start", deleted: true },
        ].map(({ suffix, source, target, deleted }) => ({
          id: `${id}-flow-${suffix}`,
          flowKey: `${id}-${suffix}`,
          sourceStepId: `${id}-${source}`,
          targetStepId: `${id}-${target}`,
          _deleted: deleted,
        })),
      )
      if (id === "prc-idle" || id === "prc-deleted") continue
      for (const kind of [
        "running",
        "completed-short",
        "completed-long",
        "abandoned",
        "not-started",
        "failed",
        "deleted-execution",
        "deleted-state",
      ]) {
        const executionId = `${id}-${kind}`
        yield* db.insert(schema.processState).values({
          id: executionId,
          processId: id,
          startStepId: `${id}-start`,
          state: {},
          _deleted: kind === "deleted-state",
        })
        yield* db.insert(schema.processExecution).values({
          id: executionId,
          processStateId: executionId,
          createdAt: sql`julianday('2026-09-01')`,
          finishedAt:
            kind === "completed-short"
              ? sql`julianday('2026-09-02')`
              : ["completed-long", "failed"].includes(kind)
                ? sql`julianday('2026-09-03')`
                : ["deleted-execution", "deleted-state"].includes(kind)
                  ? sql`julianday('2026-10-01')`
                  : null,
          abandonedAt:
            kind === "abandoned" ? sql`julianday('2026-09-01')` : null,
          notStartedReason: kind === "not-started" ? "Not started" : null,
          _deleted: kind === "deleted-execution",
        })
        yield* db.insert(schema.toDo).values(
          ["one", "two", "deleted"].map((suffix) => ({
            id: `${executionId}-${suffix}`,
            processExecutionId: executionId,
            flowId: `${id}-flow-next`,
            failureReason: kind === "failed" ? "Failure" : null,
            _deleted: suffix === "deleted" || kind.startsWith("completed"),
          })),
        )
      }
    }
  })
