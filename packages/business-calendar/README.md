# @pf/business-calendar

Calculates working time for process schedules and duration measurements.
Calendars combine weekly opening hours, holidays, named periods, and one-off
date exceptions.

Exceptions take precedence over period schedules and the normal weekly
schedule. This allows deadlines to follow actual working hours rather than
elapsed clock time.

Operations exchange UTC timestamps, while schedule times are interpreted in the
calendar's configured timezone.

## Deadlines that follow working hours

Start with a Monday–Friday, 09:00–17:00 calendar and add recurring holidays.
Holiday helpers cover fixed dates, particular weekdays, and dates relative to
Easter:

```typescript
import { DateTime, Duration, Effect } from "effect"
import {
  type BusinessCalendarConfig,
  Thursday,
  Monday,
  Weekdays,
  createDefaultConfig,
  easterRelativeHoliday,
  fixedHoliday,
  lastWeekdayHoliday,
  makeBusinessCalendarService,
  nthWeekdayHoliday,
} from "@pf/business-calendar"

const config: BusinessCalendarConfig = {
  ...createDefaultConfig([
    fixedHoliday("Christmas Day", 12, 25),
    nthWeekdayHoliday("Thanksgiving", 11, Thursday, 4),
    lastWeekdayHoliday("Memorial Day", 5, Monday),
    easterRelativeHoliday("Good Friday", -2),
  ]),
  timezone: "UTC",
}

const result = await Effect.runPromise(
  Effect.gen(function* () {
    const calendar = yield* makeBusinessCalendarService(config)
    const received = DateTime.makeUnsafe("2026-12-24T16:00:00Z")
    const deadline = yield* calendar.addBusinessHours(received, 4)
    const workingTime = yield* calendar.businessHoursBetween(received, deadline)

    return {
      deadline: DateTime.formatIso(deadline),
      workingHours: Duration.toHours(workingTime),
    }
  }),
)
// { deadline: "2026-12-28T12:00:00.000Z", workingHours: 4 }
```

One hour is counted on Thursday; Friday's holiday and the weekend are skipped,
then the remaining three hours fall on Monday. The same service can add business
days, find the next working day, or measure working time between two events.

## Split shifts and one-off changes

Continuing with the configuration above, give weekdays a lunch break and
override two particular dates:

```typescript
const adjustedConfig: BusinessCalendarConfig = {
  ...config,
  weeklySchedule: Weekdays.map((day) => ({
    day,
    ranges: [
      { open: { hour: 9, minute: 0 }, close: { hour: 12, minute: 0 } },
      { open: { hour: 13, minute: 0 }, close: { hour: 17, minute: 0 } },
    ],
  })),
  exceptions: [
    {
      date: DateTime.makeUnsafe("2026-12-24T00:00:00Z"),
      slots: [
        { open: { hour: 9, minute: 0 }, close: { hour: 12, minute: 0 } },
      ],
      note: "Christmas Eve — early closing",
    },
    {
      date: DateTime.makeUnsafe("2026-12-31T00:00:00Z"),
      slots: "closed",
      note: "Year-end closure",
    },
  ],
}
```

Working-hour calculations skip the lunch break and respect the early closing.
Weekly schedules can also describe overnight shifts, such as 22:00–06:00.

## Seasonal schedules and active periods

Named periods can replace the normal weekly schedule for a date range:

```typescript
const seasonalConfig: BusinessCalendarConfig = {
  ...adjustedConfig,
  periods: [
    {
      id: "summer-hours-2026",
      type: "summer-hours",
      name: "Summer opening hours",
      startDate: DateTime.makeUnsafe("2026-07-01T00:00:00Z"),
      endDate: DateTime.makeUnsafe("2026-08-31T00:00:00Z"),
      isActive: true,
      weeklySchedule: Weekdays.map((day) => ({
        day,
        ranges: [
          { open: { hour: 8, minute: 0 }, close: { hour: 14, minute: 0 } },
        ],
      })),
    },
  ],
}
```

Outside the period, the usual schedule applies. To count working days only
within active periods of a particular type, set `requireActivePeriod` to that
type. This suits seasonal operations or bounded service windows.

## Timezones and further reading

The examples use UTC to make the results easy to follow. Set `timezone` to an
IANA name such as `Pacific/Auckland` for local opening hours; the service handles
the conversion while continuing to accept and return UTC timestamps.

See the [calendar configuration](./src/lib/calendar-config.ts) and
[service interface](./src/lib/calendar-service.ts) for supported calculations.
