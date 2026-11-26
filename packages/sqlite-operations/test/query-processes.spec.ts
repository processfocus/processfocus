import { Effect, Layer } from "effect"
import {
  ProcessCollectionQueries,
  ProcessQueries,
} from "@pf/graphql-db-operations"
import { DatabaseTest } from "@pf/service-drizzle-sqlite/test"
import {
  SqliteProcessCollectionQueriesLive,
  SqliteProcessQueriesLive,
} from "../src/lib/query-processes"
import { seedProcessQueries } from "./query-processes.fixture"
import { expect, it } from "bun:test"

it("preserves targeted Process documents, statistics, and list paging", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* seedProcessQueries(12)
      const queries = yield* ProcessCollectionQueries
      expect(yield* queries.getProcesses([])).toEqual([])
      expect(yield* queries.getProcesses(["missing"])).toEqual([])
      const rows = yield* queries.getProcesses([
        "prc-target",
        "prc-idle",
        "prc-no-start",
        "prc-deleted",
        "prc-other-0",
        "missing",
        "prc-target",
      ])
      expect(rows.map(({ id }) => id)).toEqual([
        "prc-deleted",
        "prc-idle",
        "prc-no-start",
        "prc-other-0",
        "prc-target",
      ])
      for (const id of ["prc-target", "prc-other-0"]) {
        expect(rows.find((row) => row.id === id)).toMatchObject({
          startStepPath: `/${id}/start`,
          formFieldCount: 3,
          // Preserve the view's Todo count (including failed/abandoned states).
          activeInstances: 8,
          minDurationMs: 86400000,
          maxDurationMs: 172800000,
          deleted: false,
        })
      }
      for (const id of ["prc-idle", "prc-no-start", "prc-deleted"]) {
        expect(rows.find((row) => row.id === id)).toMatchObject({
          activeInstances: 0,
          minDurationMs: null,
          maxDurationMs: null,
        })
      }
      expect(rows.find(({ id }) => id === "prc-no-start")).toMatchObject({
        startStepPath: "",
        formFieldCount: 0,
      })
      expect(rows.find(({ id }) => id === "prc-deleted")?.deleted).toBe(true)
      expect(yield* queries.getProcesses(["prc-target"])).toEqual(
        rows.filter(({ id }) => id === "prc-target"),
      )
      const all = yield* queries.pullProcess(null, 100)
      expect(all.filter(({ id }) => rows.some((row) => row.id === id))).toEqual(
        rows,
      )
      const page = yield* queries.pullProcess(null, 2)
      const last = page.at(-1)
      expect(last).toBeDefined()
      if (!last) return
      expect(
        yield* queries.pullProcess(
          { id: last.id, updatedAt: last.updatedAt },
          2,
        ),
      ).toEqual(all.slice(2, 4))

      const catalog = yield* ProcessQueries
      const list = yield* catalog.listProcesses({ offset: 0, limit: 100 })
      expect(list).toHaveLength(14)
      expect(list.some(({ id }) => id === "prc-deleted")).toBe(false)
      expect(list.some(({ id }) => id === "prc-no-start")).toBe(false)
      expect(yield* catalog.listProcesses({ offset: 1, limit: 2 })).toEqual(
        list.slice(1, 3),
      )
      expect(
        yield* catalog.listProcesses({
          offset: 0,
          limit: 2,
          processPath: "/prc-target",
        }),
      ).toEqual(list.filter(({ id }) => id === "prc-target"))
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          SqliteProcessCollectionQueriesLive,
          SqliteProcessQueriesLive,
        ).pipe(Layer.provideMerge(DatabaseTest)),
      ),
    ),
  ))
