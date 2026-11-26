import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { SqlReadBatchError } from "@pf/db-info"
import { BusinessCalendarQueries } from "@pf/graphql-db-operations"
import { makeTursoCloudLive } from "@pf/layer-turso-cloud"
import { TypedSqliteDrizzleLayer } from "@pf/service-drizzle-sqlite"
import { SqliteBusinessCalendarQueriesLive } from "../src/lib/business-calendar-queries"
import { expect, it } from "bun:test"

const batch = Schema.Struct({
  steps: Schema.Array(
    Schema.Struct({ stmt: Schema.Struct({ sql: Schema.String }) }),
  ),
})
const pipeline = Schema.Struct({
  batch: Schema.optional(batch),
  requests: Schema.optional(
    Schema.Array(Schema.Struct({ batch: Schema.optional(batch) })),
  ),
})

it.skipIf(!Bun.which("sqld"))(
  "loads a calendar's five independent reads in one HTTP pipeline request",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "read-batch-"))
    const reserve = Bun.serve({ port: 0, fetch: () => new Response() })
    const backend = `http://127.0.0.1:${reserve.port}`
    reserve.stop(true)
    const daemon = Bun.spawn(
      ["sqld", "--db-path", directory, "--http-listen-addr", backend.slice(7)],
      { stdout: "ignore", stderr: "ignore" },
    )
    const requests: string[][] = []
    const paths: string[] = []
    const proxy = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = await request.text()
        const decoded = Schema.decodeUnknownSync(pipeline)(JSON.parse(body))
        const statements = [
          decoded.batch,
          ...(decoded.requests ?? []).map((r) => r.batch),
        ].flatMap((b) => b?.steps.map((step) => step.stmt.sql) ?? [])
        if (statements.length) {
          requests.push(statements)
          paths.push(new URL(request.url).pathname)
        }
        return fetch(backend + new URL(request.url).pathname, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept-Encoding": "identity",
          },
          body,
        })
      },
    })
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          await fetch(backend)
          break
        } catch {
          await Bun.sleep(20)
        }
      }
      const cloud = makeTursoCloudLive().pipe(
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              SQLITE_DATABASE_PATH: `http://127.0.0.1:${proxy.port}`,
            }),
          ),
        ),
      )
      const layer = SqliteBusinessCalendarQueriesLive.pipe(
        Layer.provideMerge(
          TypedSqliteDrizzleLayer.pipe(Layer.provideMerge(cloud)),
        ),
      )
      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const calendars = yield* BusinessCalendarQueries
          // Minimal disposable schema for the real production query group.
          for (const statement of [
            "CREATE TABLE pf_org_unit (id TEXT, timezone TEXT, _deleted INTEGER)",
            "CREATE TABLE pf_weekly_schedule (org_unit_id TEXT, day_of_week INTEGER, time_ranges TEXT, _deleted INTEGER)",
            "CREATE TABLE pf_date_exception (org_unit_id TEXT, exception_date REAL, exception_slots TEXT, exception_note TEXT, _deleted INTEGER)",
            "CREATE TABLE pf_holiday_instance (org_unit_id TEXT, holiday_title TEXT, holiday_rule TEXT, holiday_date REAL, _deleted INTEGER)",
            "CREATE TABLE pf_calendar_period (org_unit_id TEXT, period_kind TEXT, period_title TEXT, period_start REAL, period_end REAL, period_active INTEGER, period_schedule TEXT, _deleted INTEGER)",
            "INSERT INTO pf_org_unit VALUES ('calendar', 'Pacific/Auckland', 0)",
            `INSERT INTO pf_weekly_schedule VALUES ('calendar', 3, '[{"open":{"hour":9,"minute":0},"close":{"hour":17,"minute":0}}]', 0)`,
            "INSERT INTO pf_date_exception VALUES ('calendar', 2461306.5, '\"closed\"', 'Holiday', 0)",
            "INSERT INTO pf_holiday_instance VALUES ('calendar', 'Holiday', '{}', NULL, 0)",
            "INSERT INTO pf_calendar_period VALUES ('calendar', 'term', 'Term', 2461306.5, 2461307.5, 1, NULL, 0)",
          ])
            yield* sql.unsafe(statement)
          requests.length = 0
          paths.length = 0
          const data = yield* calendars.getCalendarData(["calendar"])
          expect(data.get("calendar")).toEqual({
            orgUnitId: "calendar",
            timezone: "Pacific/Auckland",
            weeklySchedule: [
              {
                orgUnitId: "calendar",
                dayOfWeek: 3,
                timeRanges: [
                  {
                    open: { hour: 9, minute: 0 },
                    close: { hour: 17, minute: 0 },
                  },
                ],
              },
            ],
            dateExceptions: [
              {
                orgUnitId: "calendar",
                exceptionDate: 1790121600000,
                exceptionSlots: "closed",
                exceptionNote: "Holiday",
              },
            ],
            holidays: [
              {
                orgUnitId: "calendar",
                holidayTitle: "Holiday",
                holidayRule: {},
              },
            ],
            periods: [
              {
                orgUnitId: "calendar",
                periodKind: "term",
                periodTitle: "Term",
                periodStart: 1790121600000,
                periodEnd: 1790208000000,
                periodActive: true,
              },
            ],
          })
          expect(
            requests.flat().filter((sql) => sql !== "SELECT 1"),
          ).toHaveLength(5)
          expect(requests).toHaveLength(1)
          expect(paths).toEqual(["/v3/pipeline"])
          // Drizzle's Promise boundary must retain the indexed SQL error and
          // the first SELECT's completed result when the second SELECT fails.
          yield* sql.unsafe("DROP TABLE pf_weekly_schedule")
          requests.length = 0
          const error = yield* Effect.flip(
            calendars.getCalendarData(["calendar"]),
          )
          expect(error.message).toContain("pf_weekly_schedule")
          const cause = error.reason.cause
          expect(cause).toBeInstanceOf(SqlReadBatchError)
          if (cause instanceof SqlReadBatchError) {
            expect(cause.statementIndex).toBe(1)
            expect(cause.results).toEqual([
              [["calendar", "Pacific/Auckland"]],
              null,
              null,
              null,
              null,
            ])
          }
          expect(requests).toHaveLength(1)
        }).pipe(Effect.provide(layer)),
      )
    } finally {
      proxy.stop(true)
      daemon.kill()
      await daemon.exited
      await rm(directory, { recursive: true, force: true })
    }
  },
  30_000,
)
