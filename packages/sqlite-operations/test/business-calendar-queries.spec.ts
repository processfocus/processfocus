import { SqlClient } from "@effect/sql"
import { DateTime, Effect, Layer } from "effect"
import * as schema from "@pf/drizzle-sqlite"
import { BusinessCalendarQueries } from "@pf/graphql-db-operations"
import {
  DatabaseTest,
  TypedSqliteDrizzle,
} from "@pf/service-drizzle-sqlite/test"
import { SqliteBusinessCalendarQueriesLive } from "../src/lib/business-calendar-queries"
import { expect, it } from "bun:test"

it("loads only live calendar entries and uses org-unit indexes", async () => {
  const layer = SqliteBusinessCalendarQueriesLive.pipe(
    Layer.provideMerge(DatabaseTest),
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      const sql = yield* SqlClient.SqlClient
      const calendars = yield* BusinessCalendarQueries
      const day = DateTime.unsafeMake("2026-09-23T00:00:00Z")
      for (const orgUnitId of ["ou-calendar", "ou-other"]) {
        yield* db.insert(schema.orgUnit).values({
          id: orgUnitId,
          name: orgUnitId,
          path: orgUnitId,
          orgUnitLevel: "organisation",
          timezone: "Pacific/Auckland",
        })
        for (const deleted of [false, true]) {
          yield* db.insert(schema.weeklySchedule).values({
            orgUnitId,
            dayOfWeek: 3,
            timeRanges: [],
            _deleted: deleted,
          })
          yield* db.insert(schema.dateException).values({
            orgUnitId,
            exceptionDate: day,
            exceptionSlots: [],
            _deleted: deleted,
          })
          yield* db.insert(schema.holidayInstance).values({
            orgUnitId,
            holidayTitle: "Holiday",
            holidayRule: {},
            holidayDate: day,
            _deleted: deleted,
          })
          yield* db.insert(schema.calendarPeriod).values({
            orgUnitId,
            periodKind: "term",
            periodTitle: "Term",
            periodStart: day,
            periodEnd: day,
            periodActive: true,
            _deleted: deleted,
          })
        }
      }
      const result = yield* calendars.getCalendarData(["ou-calendar"])
      expect(result.size).toBe(1)
      const calendar = result.get("ou-calendar")!
      expect(calendar.timezone).toBe("Pacific/Auckland")
      expect(calendar.weeklySchedule).toHaveLength(1)
      expect(calendar.dateExceptions).toHaveLength(1)
      expect(calendar.holidays).toHaveLength(1)
      expect(calendar.periods).toHaveLength(1)
      for (const table of [
        "pf_weekly_schedule",
        "pf_date_exception",
        "pf_holiday_instance",
        "pf_calendar_period",
      ]) {
        const plan = yield* sql.unsafe<{ detail: string }>(
          `EXPLAIN QUERY PLAN SELECT * FROM ${table} WHERE org_unit_id IN (?) AND _deleted = ?`,
          ["ou-calendar", 0],
        )
        expect(
          plan.some(({ detail }) =>
            detail.includes(`SEARCH ${table} USING INDEX`),
          ),
        ).toBe(true)
      }
    }).pipe(Effect.provide(layer)),
  )
})
