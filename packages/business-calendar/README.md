# @pf/business-calendar

Effect-based business calendar service for calculating business days and hours, with support for holidays, calendar periods (school terms, fiscal quarters, etc.), and date exceptions.

## Features

- **Business day/hour calculations**: `isBusinessDay`, `isBusinessHours`, `addBusinessDays`, `addBusinessHours`
- **Holiday support**: Fixed dates, nth weekday (e.g., 4th Thursday), last weekday of month, Easter-relative
- **Calendar periods**: School terms, fiscal quarters, seasons with optional schedule overrides
- **Date exceptions**: One-off overrides for specific dates (early closing, special hours)
- **Configurable weekly schedule**: Multiple time ranges per day, overnight ranges supported

## Usage

```typescript
import {
  BusinessCalendarService,
  makeBusinessCalendarServiceLayer,
  createDefaultConfig,
  type Holiday,
  type DayOfWeek,
} from "@pf/business-calendar"
import { DateTime, Effect } from "effect"

// Define holidays
const holidays: Holiday[] = [
  { _tag: "FixedHoliday", month: 1, day: 1, name: "New Year's Day" },
  { _tag: "FixedHoliday", month: 12, day: 25, name: "Christmas Day" },
  { _tag: "NthWeekdayHoliday", month: 11, weekday: 4, n: 4, name: "Thanksgiving" },
  { _tag: "EasterRelativeHoliday", offset: -2, name: "Good Friday" },
]

// Create config (timezone is on Organisation, not here)
const config = createDefaultConfig(holidays)

// Or build custom config
const customConfig = {
  weeklySchedule: [
    { day: 1 as DayOfWeek, ranges: [{ open: { hour: 8, minute: 30 }, close: { hour: 17, minute: 0 } }] },
    { day: 2 as DayOfWeek, ranges: [{ open: { hour: 8, minute: 30 }, close: { hour: 17, minute: 0 } }] },
    // ... etc
  ],
  holidays,
  exceptions: [],
  nonWorkingDays: [0 as DayOfWeek, 6 as DayOfWeek], // Sunday, Saturday
  periods: [],
}

// Use the service
const program = Effect.gen(function* () {
  const calendar = yield* BusinessCalendarService

  const date = DateTime.unsafeMake({ year: 2025, month: 1, day: 6 })

  const isWorkday = yield* calendar.isBusinessDay(date)
  const nextWorkday = yield* calendar.nextBusinessDay(date)
  const fiveDaysLater = yield* calendar.addBusinessDays(date, 5)

  // With time
  const datetime = DateTime.unsafeMake({ year: 2025, month: 1, day: 6, hour: 14, minute: 30 })
  const isOpen = yield* calendar.isBusinessHours(datetime)
  const twoHoursLater = yield* calendar.addBusinessHours(datetime, 2)
})

// Provide the service layer
Effect.runPromise(
  program.pipe(
    Effect.provide(makeBusinessCalendarServiceLayer(config))
  )
)
```

## Calendar Periods

Calendar periods allow you to define date ranges like school terms or fiscal quarters:

```typescript
import { DateTime } from "effect"

const config = {
  // ... other config
  periods: [
    {
      type: "school_term",
      name: "Fall 2025",
      startDate: DateTime.unsafeMake({ year: 2025, month: 9, day: 1 }),
      endDate: DateTime.unsafeMake({ year: 2025, month: 12, day: 20 }),
      isActive: true,
    },
  ],
  // Only count days within active school terms as business days
  requireActivePeriod: "school_term",
}
```

## Date Exceptions

Override schedule for specific dates:

```typescript
const config = {
  // ... other config
  exceptions: [
    {
      date: DateTime.unsafeMake({ year: 2025, month: 12, day: 24 }),
      slots: [{ open: { hour: 9, minute: 0 }, close: { hour: 12, minute: 0 } }],
      note: "Christmas Eve - early closing",
    },
    {
      date: DateTime.unsafeMake({ year: 2025, month: 12, day: 31 }),
      slots: "closed",
      note: "New Year's Eve - closed",
    },
  ],
}
```

## API

### BusinessCalendarService

| Method | Description |
|--------|-------------|
| `isBusinessDay(date)` | Check if date is a business day |
| `isBusinessHours(datetime)` | Check if datetime is within business hours |
| `addBusinessDays(date, days)` | Add/subtract business days |
| `addBusinessHours(datetime, hours)` | Add business hours |
| `nextBusinessDay(date)` | Get next business day |
| `businessDayStart(date)` | Get start time of business day |
| `businessDayEnd(date)` | Get end time of business day |
| `businessHoursRemaining(datetime)` | Get remaining business hours today |
| `businessDaysBetween(start, end)` | Count business days in range |
| `businessHoursBetween(start, end)` | Calculate business hours in range |
| `isHoliday(date)` | Check if date is a holiday |
| `getHolidaysForYear(year)` | Get all holidays for a year |
| `getActivePeriods(date)` | Get active calendar periods for date |
| `getActivePeriodsByType(date, type)` | Get active periods of specific type |
| `isWithinPeriodType(date, type)` | Check if date is within any period of type |
| `getEffectiveSchedule(date)` | Get the schedule in effect for date |

## Note on Timezone

Timezone is stored at the Organisation level, not in the calendar config. The calendar service operates on `DateTime.Utc` values. Timezone conversion should happen at the application boundary.
