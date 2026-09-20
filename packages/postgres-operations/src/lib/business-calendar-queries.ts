import { inArray, isNull, sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import * as schema from "@pf/drizzle-postgres"
import {
  BusinessCalendarQueries,
  type CalendarPeriodRow,
  type DateExceptionRow,
  type HolidayInstanceRow,
  type OrgUnitCalendarData,
  type TimeRange,
  type WeeklyScheduleRow,
} from "@pf/graphql-db-operations"
import { TypedPostgresDrizzle } from "@pf/service-drizzle-postgres"

/**
 * Live implementation of BusinessCalendarQueries for Postgres.
 */
export const PostgresBusinessCalendarQueriesLive = Layer.effect(
  BusinessCalendarQueries,
  Effect.gen(function* () {
    const db = yield* TypedPostgresDrizzle

    return {
      getCalendarData: (orgUnitIds) =>
        Effect.gen(function* () {
          if (orgUnitIds.length === 0) {
            return new Map()
          }

          // Fetch all calendar-related data in parallel
          const [orgUnits, weeklySchedules, dateExceptions, holidays, periods] =
            yield* Effect.all(
              [
                // Org units with timezone
                db
                  .select({
                    id: schema.orgUnit.id,
                    timezone: schema.orgUnit.timezone,
                  })
                  .from(schema.orgUnit)
                  .where(inArray(schema.orgUnit.id, orgUnitIds)),

                // Weekly schedules
                db
                  .select({
                    orgUnitId: schema.weeklySchedule.orgUnitId,
                    dayOfWeek: schema.weeklySchedule.dayOfWeek,
                    timeRanges: schema.weeklySchedule.timeRanges,
                  })
                  .from(schema.weeklySchedule)
                  .where(inArray(schema.weeklySchedule.orgUnitId, orgUnitIds)),

                // Date exceptions
                db
                  .select({
                    orgUnitId: schema.dateException.orgUnitId,
                    // Postgres uses EXTRACT(EPOCH FROM timestamp) * 1000 for epoch ms
                    exceptionDate:
                      sql<number>`EXTRACT(EPOCH FROM ${schema.dateException.exceptionDate}) * 1000`.as(
                        "exception_date_ms",
                      ),
                    exceptionSlots: schema.dateException.exceptionSlots,
                    exceptionNote: schema.dateException.exceptionNote,
                  })
                  .from(schema.dateException)
                  .where(inArray(schema.dateException.orgUnitId, orgUnitIds)),

                // Holiday instances
                db
                  .select({
                    orgUnitId: schema.holidayInstance.orgUnitId,
                    holidayTitle: schema.holidayInstance.holidayTitle,
                    holidayRule: schema.holidayInstance.holidayRule,
                    // Postgres uses EXTRACT(EPOCH FROM timestamp) * 1000 for epoch ms (if present)
                    holidayDate: sql<
                      number | null
                    >`CASE WHEN ${schema.holidayInstance.holidayDate} IS NOT NULL THEN EXTRACT(EPOCH FROM ${schema.holidayInstance.holidayDate}) * 1000 ELSE NULL END`.as(
                      "holiday_date_ms",
                    ),
                  })
                  .from(schema.holidayInstance)
                  .where(inArray(schema.holidayInstance.orgUnitId, orgUnitIds)),

                // Calendar periods
                db
                  .select({
                    orgUnitId: schema.calendarPeriod.orgUnitId,
                    periodKind: schema.calendarPeriod.periodKind,
                    periodTitle: schema.calendarPeriod.periodTitle,
                    // Postgres uses EXTRACT(EPOCH FROM timestamp) * 1000 for epoch ms
                    periodStart:
                      sql<number>`EXTRACT(EPOCH FROM ${schema.calendarPeriod.periodStart}) * 1000`.as(
                        "period_start_ms",
                      ),
                    periodEnd:
                      sql<number>`EXTRACT(EPOCH FROM ${schema.calendarPeriod.periodEnd}) * 1000`.as(
                        "period_end_ms",
                      ),
                    periodActive: schema.calendarPeriod.periodActive,
                    periodSchedule: schema.calendarPeriod.periodSchedule,
                  })
                  .from(schema.calendarPeriod)
                  .where(inArray(schema.calendarPeriod.orgUnitId, orgUnitIds)),
              ],
              { concurrency: "unbounded" },
            )

          // Build a map of org unit ID to timezone
          const timezoneMap = new Map<string, string>()
          for (const row of orgUnits) {
            timezoneMap.set(row.id, row.timezone)
          }

          // Group data by org unit ID
          const result = new Map<string, OrgUnitCalendarData>()

          // Initialize empty data for all org units with their timezone
          for (const orgUnitId of orgUnitIds) {
            result.set(orgUnitId, {
              orgUnitId,
              timezone: timezoneMap.get(orgUnitId) ?? "UTC",
              weeklySchedule: [],
              dateExceptions: [],
              holidays: [],
              periods: [],
            })
          }

          // Populate weekly schedules
          for (const row of weeklySchedules) {
            const data = result.get(row.orgUnitId)
            if (data) {
              const scheduleRow: WeeklyScheduleRow = {
                orgUnitId: row.orgUnitId,
                dayOfWeek: row.dayOfWeek,
                timeRanges: row.timeRanges as unknown as TimeRange[],
              }
              data.weeklySchedule.push(scheduleRow)
            }
          }

          // Populate date exceptions
          for (const row of dateExceptions) {
            const data = result.get(row.orgUnitId)
            if (data) {
              const exceptionRow: DateExceptionRow = {
                orgUnitId: row.orgUnitId,
                exceptionDate: row.exceptionDate,
                exceptionSlots: row.exceptionSlots as unknown as
                  | TimeRange[]
                  | "closed",
              }
              if (row.exceptionNote !== null) {
                exceptionRow.exceptionNote = row.exceptionNote
              }
              data.dateExceptions.push(exceptionRow)
            }
          }

          // Populate holidays
          for (const row of holidays) {
            const data = result.get(row.orgUnitId)
            if (data) {
              const holidayRow: HolidayInstanceRow = {
                orgUnitId: row.orgUnitId,
                holidayTitle: row.holidayTitle,
                holidayRule: row.holidayRule,
              }
              if (row.holidayDate !== null) {
                holidayRow.holidayDate = row.holidayDate
              }
              data.holidays.push(holidayRow)
            }
          }

          // Populate periods
          for (const row of periods) {
            const data = result.get(row.orgUnitId)
            if (data) {
              const periodRow: CalendarPeriodRow = {
                orgUnitId: row.orgUnitId,
                periodKind: row.periodKind,
                periodTitle: row.periodTitle,
                periodStart: row.periodStart,
                periodEnd: row.periodEnd,
                periodActive: row.periodActive,
              }
              if (row.periodSchedule !== null) {
                periodRow.periodSchedule = row.periodSchedule
              }
              data.periods.push(periodRow)
            }
          }

          return result
        }),

      getRootOrgUnit: () =>
        Effect.gen(function* () {
          const rows = yield* db
            .select({ id: schema.orgUnit.id })
            .from(schema.orgUnit)
            .where(isNull(schema.orgUnit.parentOrgUnitId))
            .limit(1)

          return rows[0]?.id ?? null
        }),
    }
  }),
)
