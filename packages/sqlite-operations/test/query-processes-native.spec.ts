import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { connect } from "@tursodatabase/database"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import {
  ProcessCollectionQueries,
  ProcessQueries,
} from "@pf/graphql-db-operations"
import { TypedSqliteDrizzleLayer } from "@pf/service-drizzle-sqlite"
import { DatabaseTestFile } from "@pf/service-drizzle-sqlite/test-file"
import {
  SqliteProcessCollectionQueriesLive,
  SqliteProcessQueriesLive,
} from "../src/lib/query-processes"
import { seedProcessQueries } from "./query-processes.fixture"
import type { SQLQueryBindings } from "bun:sqlite"
import { Database } from "bun:sqlite"
import { expect, it } from "bun:test"

// Capture at the SQL-client boundary so the replay uses the production builder,
// not a parallel hand-written query or a test-only production export.
interface CapturedQuery {
  readonly name: string
  readonly sql: string
  readonly params: ReadonlyArray<unknown>
}

it("bounds targeted Process lookups on native Turso WAL and MVCC", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pf-process-queries-"))
  const path = join(directory, "sqlite.db")
  const queries: CapturedQuery[] = []
  const targetedScans: string[] = []
  const unrelatedCount = Number(
    process.env["PF_PROCESS_QUERY_UNRELATED"] ?? 250,
  )
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedProcessQueries(unrelatedCount)
        const client = yield* SqlClient.SqlClient
        let name = ""
        const captured = new Proxy(client, {
          get(target, key, receiver) {
            if (key === "unsafe") {
              return (sql: string, params: ReadonlyArray<unknown> = []) => {
                if (name) queries.push({ name, sql, params })
                return target.unsafe(sql, params)
              }
            }
            return Reflect.get(target, key, receiver)
          },
        })
        yield* Effect.gen(function* () {
          const collection = yield* ProcessCollectionQueries
          const catalog = yield* ProcessQueries
          yield* collection.observeProcesses("scope", [
            "prc-target",
            "prc-deleted",
          ])
          yield* collection.observeProcesses("other-scope", [
            "prc-idle",
            "prc-target",
          ])
          name = "empty"
          expect(yield* collection.getProcesses([])).toEqual([])
          expect(queries).toHaveLength(0)
          name = "single"
          yield* collection.getProcesses(["prc-target"])
          name = "multi"
          yield* collection.getProcesses([
            "prc-target",
            "prc-idle",
            "prc-no-start",
          ])
          name = "missing"
          yield* collection.getProcesses(["missing"])
          name = "pull"
          yield* collection.pullProcess(null, 2)
          name = "list-by-path"
          for (const [id, activeInstances] of [
            ["prc-target", 8],
            ["prc-idle", 0],
            ["prc-deleted", null],
            ["prc-no-start", null],
            ["missing", null],
          ] as const) {
            const rows = yield* catalog.listProcesses({
              processPath: `/${id}`,
              offset: 0,
              limit: 2,
            })
            if (activeInstances === null) {
              expect(rows).toEqual([])
            } else {
              expect(rows).toMatchObject([
                { id, startStepPath: `/${id}/start`, activeInstances },
              ])
            }
          }
          name = "observed-processes"
          expect(
            yield* collection.getObservedProcessIds("scope", ["prc-target"]),
          ).toEqual(["prc-target"])
          const observed = yield* collection.getObservedProcessIds("scope", [
            "prc-target",
            "prc-deleted",
            "prc-idle",
            ...Array.from({ length: 13 }, (_, i) => `prc-other-${i}`),
          ])
          expect(observed.sort()).toEqual(["prc-deleted", "prc-target"])
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              SqliteProcessCollectionQueriesLive,
              SqliteProcessQueriesLive,
            ).pipe(
              Layer.provide(Layer.fresh(TypedSqliteDrizzleLayer)),
              Layer.provide(Layer.succeed(SqlClient.SqlClient, captured)),
            ),
          ),
        )
      }).pipe(Effect.provide(DatabaseTestFile(path))),
    )
    const sqlite = new Database(path, { readonly: true })
    try {
      for (const mode of ["wal", "mvcc"]) {
        const nativePath = join(directory, `${mode}.db`)
        copyFileSync(path, nativePath)
        const native = await connect(nativePath, { defaultQueryTimeout: 30000 })
        try {
          const journalMode = await (
            await native.prepare(`PRAGMA journal_mode = ${mode}`)
          ).all()
          expect(journalMode).toEqual([{ journal_mode: mode }])
          const version = await (
            await native.prepare("SELECT sqlite_version(), turso_version()")
          ).all()
          const results = []
          for (const query of queries) {
            const params = query.params.map((value): SQLQueryBindings => {
              if (
                value === null ||
                typeof value === "string" ||
                typeof value === "number"
              ) {
                return value
              }
              throw new Error("Unexpected Process query binding")
            })
            const expected = sqlite.query(query.sql).values(...params)
            const plan = await (
              await native.prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
            ).all(...params)
            if (
              query.name === "list-by-path" ||
              query.name === "observed-processes"
            ) {
              for (const { detail } of plan) {
                if (
                  /^SCAN (?:pf_process(?:_state|_execution|_visibility)?|pf_step|start_step|pf_flow|pf_to_do)\b/u.test(
                    detail,
                  )
                ) {
                  targetedScans.push(`${mode} ${query.name}: ${detail}`)
                }
              }
            }
            const statement = await native.prepare(query.sql)
            const samplesMs: number[] = []
            for (let repeat = 0; repeat < 3; repeat++) {
              const start = performance.now()
              const rows = await statement.raw(true).all(...params)
              samplesMs.push(performance.now() - start)
              expect(rows).toEqual(expected)
            }
            results.push({ ...query, plan, samplesMs })
            if (["single", "multi", "missing"].includes(query.name)) {
              // Generous budget: the repaired query takes ~1 ms; the original
              // takes seconds at 250 unrelated Processes on this same engine.
              expect(Math.max(...samplesMs)).toBeLessThan(1000)
            }
          }
          const evidenceDirectory = process.env["PF_PROCESS_QUERY_EVIDENCE_DIR"]
          if (evidenceDirectory) {
            mkdirSync(evidenceDirectory, { recursive: true })
            writeFileSync(
              join(evidenceDirectory, `process-${mode}-${unrelatedCount}.json`),
              JSON.stringify(
                { unrelatedCount, mode, version, results },
                null,
                2,
              ),
            )
          }
        } finally {
          await native.close()
        }
      }
    } finally {
      sqlite.close()
    }
    expect(targetedScans).toEqual([])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 120000)
