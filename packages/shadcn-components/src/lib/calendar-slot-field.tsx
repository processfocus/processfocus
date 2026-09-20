"use client"

import type { StandardSchemaV1Issue } from "@tanstack/react-form"
import { useEffect, useMemo, useRef, useState } from "react"
import type {
  CalendarSlotCalendarMetadata,
  CalendarSlotWeekday,
} from "@pf/form-schema"
import { useFieldContext, useFormContext } from "./form-context"
import { Field, FieldDescription, FieldError, FieldLabel } from "./ui/field"
import { cn } from "./utils/utils"

export interface CalendarSlotFieldItem {
  readonly value: string
  readonly startsAt: string
  readonly endsAt: string
  readonly label?: string | undefined
}

export interface CalendarSlotFieldProps {
  readonly label: string
  readonly descriptionHtml?: string | undefined | null
  readonly emptyMessageHtml?: string | undefined | null
  readonly loadErrorMessageHtml?: string | undefined | null
  readonly slots: CalendarSlotFieldItem[]
  readonly loading: boolean
  readonly error?: boolean | undefined
  readonly readOnly?: boolean
  readonly autoFocus?: boolean
  readonly timeZone: string
  readonly locale: string
  readonly calendar?: CalendarSlotCalendarMetadata | undefined
  readonly onRetry?: (() => void) | undefined
}

type CalendarSlotMonthCell =
  | { readonly _tag: "blank"; readonly key: string }
  | {
      readonly _tag: "day"
      readonly key: string
      readonly dateKey: string
      readonly day: number
      readonly inVisibleMonth: boolean
    }

const DAY_NUMBER_FONT_FAMILY =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'
// 2026-01-04 is a known Sunday; offset from it for locale-specific weekday labels.
const WEEKDAY_REFERENCE_SUNDAY = Date.UTC(2026, 0, 4)

const dateKeyFormatter = (timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })

const dateKeyFromDate = (date: Date, timeZone: string): string => {
  const parts = dateKeyFormatter(timeZone).formatToParts(date)
  const year = parts.find((part) => part.type === "year")?.value
  const month = parts.find((part) => part.type === "month")?.value
  const day = parts.find((part) => part.type === "day")?.value

  return year && month && day ? `${year}-${month}-${day}` : ""
}

const parseDateKey = (key: string) => {
  const [year = 0, month = 1, day = 1] = key
    .split("-")
    .map((part) => Number(part))
  return { day, month, year }
}

const parseMonthKey = (key: string) => {
  const [year = 0, month = 1] = key.split("-").map((part) => Number(part))
  return { month, year }
}

const padded = (value: number) => value.toString().padStart(2, "0")

const dateKeyFromParts = (year: number, month: number, day: number): string =>
  `${year}-${padded(month)}-${padded(day)}`

const monthKeyFromParts = (year: number, month: number): string =>
  `${year}-${padded(month)}`

const monthKeyFromDateKey = (key: string): string => key.slice(0, 7)

const monthIndex = (key: string): number => {
  const { year, month } = parseMonthKey(key)
  return year * 12 + month - 1
}

const compareMonthKeys = (left: string, right: string): number =>
  monthIndex(left) - monthIndex(right)

const addMonthsToMonthKey = (key: string, offset: number): string => {
  const { year, month } = parseMonthKey(key)
  const date = new Date(Date.UTC(year, month - 1 + offset, 1))
  return monthKeyFromParts(date.getUTCFullYear(), date.getUTCMonth() + 1)
}

const addDaysToDateKey = (key: string, offset: number): string => {
  const { year, month, day } = parseDateKey(key)
  const date = new Date(Date.UTC(year, month - 1, day + offset))
  return dateKeyFromParts(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
  )
}

const monthDateFromKey = (key: string): Date => {
  const { year, month } = parseMonthKey(key)
  return new Date(Date.UTC(year, month - 1, 1))
}

const dayOfWeekFromKey = (key: string): CalendarSlotWeekday => {
  const { year, month, day } = parseDateKey(key)
  return new Date(
    Date.UTC(year, month - 1, day),
  ).getUTCDay() as CalendarSlotWeekday
}

const formatMonthTitle = (key: string, locale: string): string =>
  new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  })
    .format(monthDateFromKey(key))
    .toUpperCase()

const formatDateHeading = (key: string, locale: string): string => {
  const { year, month, day } = parseDateKey(key)
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(Date.UTC(year, month - 1, day)))
}

const formatStartTime = (
  slot: CalendarSlotFieldItem,
  timeZone: string,
  locale: string,
): string => {
  const parts = new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).formatToParts(new Date(slot.startsAt))
  const hour = parts.find((part) => part.type === "hour")?.value
  const minute = parts.find((part) => part.type === "minute")?.value ?? "00"
  const dayPeriod =
    parts.find((part) => part.type === "dayPeriod")?.value.toLowerCase() ?? ""

  if (!hour) {
    return ""
  }

  return minute === "00"
    ? `${hour}${dayPeriod}`
    : `${hour}:${minute}${dayPeriod}`
}

const weekDayLabels = (
  weekStartsOn: CalendarSlotWeekday,
  locale: string,
): Array<{ readonly day: CalendarSlotWeekday; readonly label: string }> =>
  Array.from({ length: 7 }, (_value, index) => {
    const day = ((weekStartsOn + index) % 7) as CalendarSlotWeekday
    const label = new Intl.DateTimeFormat(locale, {
      timeZone: "UTC",
      weekday: "short",
    })
      .format(new Date(WEEKDAY_REFERENCE_SUNDAY + day * 86_400_000))
      .toUpperCase()

    return { day, label }
  })

const buildMonthCells = (
  monthKey: string,
  weekStartsOn: CalendarSlotWeekday,
): CalendarSlotMonthCell[] => {
  const { year, month } = parseMonthKey(monthKey)
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const firstDayOfWeek = new Date(Date.UTC(year, month - 1, 1)).getUTCDay()
  const leadingBlankCount = (firstDayOfWeek - weekStartsOn + 7) % 7
  const totalCells = Math.ceil((leadingBlankCount + daysInMonth) / 7) * 7

  return Array.from({ length: totalCells }, (_value, index) => {
    const dayOffset = index - leadingBlankCount + 1
    if (dayOffset < 1) {
      return { _tag: "blank", key: `blank-${index}` }
    }

    const dateKey =
      dayOffset <= daysInMonth
        ? dateKeyFromParts(year, month, dayOffset)
        : addDaysToDateKey(
            dateKeyFromParts(year, month, daysInMonth),
            dayOffset - daysInMonth,
          )
    const { day } = parseDateKey(dateKey)
    return {
      _tag: "day",
      key: dateKey,
      dateKey,
      day,
      inVisibleMonth: monthKeyFromDateKey(dateKey) === monthKey,
    }
  })
}

const monthRows = (cells: CalendarSlotMonthCell[]): CalendarSlotMonthCell[][] =>
  Array.from({ length: Math.ceil(cells.length / 7) }, (_value, index) =>
    cells.slice(index * 7, index * 7 + 7),
  )

const isBusinessDay = (
  key: string,
  businessDays: readonly CalendarSlotWeekday[] | undefined,
): boolean => !businessDays || businessDays.includes(dayOfWeekFromKey(key))

const isBusinessDayOfWeek = (
  day: CalendarSlotWeekday,
  businessDays: readonly CalendarSlotWeekday[] | undefined,
): boolean => !businessDays || businessDays.includes(day)

function CalendarSlotArrow({
  direction,
}: {
  readonly direction: "next" | "previous"
}) {
  return (
    <svg
      aria-hidden="true"
      className="h-5 w-5 fill-current"
      viewBox="0 0 16 16"
    >
      <path
        d={
          direction === "previous"
            ? "M11.5 2 4.5 8l7 6z"
            : "M4.5 2 11.5 8l-7 6z"
        }
      />
    </svg>
  )
}

function CalendarSlotMonthCalendar({
  autoFocus,
  autoFocusDayKey,
  businessDays,
  canGoNext,
  canGoPrevious,
  firstSlotByDay,
  label,
  locale,
  loading,
  onNextMonth,
  onPreviousMonth,
  onSelectDay,
  readOnly,
  selectedSlotDayKey,
  timeZone,
  todayKey,
  visibleMonthKey,
  weekStartsOn,
}: {
  readonly autoFocus?: boolean | undefined
  readonly autoFocusDayKey?: string | undefined
  readonly businessDays?: readonly CalendarSlotWeekday[] | undefined
  readonly canGoNext: boolean
  readonly canGoPrevious: boolean
  readonly firstSlotByDay: ReadonlyMap<string, CalendarSlotFieldItem>
  readonly label: string
  readonly locale: string
  readonly loading?: boolean | undefined
  readonly onNextMonth?: (() => void) | undefined
  readonly onPreviousMonth?: (() => void) | undefined
  readonly onSelectDay?:
    | ((dayKey: string, slot: CalendarSlotFieldItem) => void)
    | undefined
  readonly readOnly?: boolean | undefined
  readonly selectedSlotDayKey?: string | undefined
  readonly timeZone: string
  readonly todayKey: string
  readonly visibleMonthKey: string
  readonly weekStartsOn: CalendarSlotWeekday
}) {
  const autoFocusButtonRef = useRef<HTMLButtonElement | null>(null)
  const monthTitle = formatMonthTitle(visibleMonthKey, locale)
  const cells = buildMonthCells(visibleMonthKey, weekStartsOn)
  const labels = weekDayLabels(weekStartsOn, locale)

  useEffect(() => {
    if (autoFocus !== true) {
      return
    }

    autoFocusButtonRef.current?.focus()
  }, [autoFocus])

  return (
    <>
      <style>{`
        [data-calendar-slot-calendar] [data-calendar-slot-day] {
          min-height: var(--calendar-slot-cell-height);
        }

        [data-calendar-slot-calendar] [data-calendar-slot-blank] {
          height: var(--calendar-slot-cell-height);
        }

        [data-calendar-slot-calendar] {
          --calendar-slot-cell-height: 4.75rem;
        }

        @media (max-width: 639px) {
          [data-calendar-slot-calendar] {
            margin-left: calc(-1.5rem - 1px);
            margin-right: calc(-1.5rem - 1px);
            width: calc(100% + 3rem + 2px);
          }
        }

        @media (min-width: 640px) {
          [data-calendar-slot-calendar] {
            --calendar-slot-cell-height: 6rem;
          }
        }
      `}</style>
      <div
        data-calendar-slot-calendar=""
        className={cn(
          "overflow-hidden rounded-lg border bg-background",
          loading && "animate-pulse bg-muted/10",
        )}
      >
        <div className="flex items-center gap-2 px-2 py-3 sm:px-4 sm:py-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-start">
            {canGoPrevious && onPreviousMonth ? (
              <button
                type="button"
                aria-label="Show previous month"
                className="inline-flex h-10 w-10 items-center justify-center rounded-md hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={onPreviousMonth}
              >
                <CalendarSlotArrow direction="previous" />
              </button>
            ) : null}
          </div>

          <p
            className="min-w-0 flex-1 whitespace-nowrap text-center text-xl font-medium tracking-[0.2em] text-foreground/90 sm:text-4xl"
            style={{ fontFamily: DAY_NUMBER_FONT_FAMILY }}
          >
            {monthTitle}
          </p>

          <div className="flex h-10 w-10 shrink-0 items-center justify-end">
            {canGoNext && onNextMonth ? (
              <button
                type="button"
                aria-label="Show next month"
                className="inline-flex h-10 w-10 items-center justify-center rounded-md hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={onNextMonth}
              >
                <CalendarSlotArrow direction="next" />
              </button>
            ) : null}
          </div>
        </div>

        <table className="w-full table-fixed border-collapse border-t">
          <caption className="sr-only">
            {label} for {monthTitle}
          </caption>
          <thead>
            <tr>
              {labels.map(({ day, label }) => (
                <th
                  key={String(day)}
                  scope="col"
                  className={cn(
                    "border px-1 py-2 text-center font-mono text-xs font-medium tracking-[0.18em] text-foreground sm:text-sm",
                    !isBusinessDayOfWeek(day, businessDays) &&
                      "text-muted-foreground",
                  )}
                >
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {monthRows(cells).map((row) => (
              <tr key={row.map((cell) => cell.key).join(":")}>
                {row.map((cell) => {
                  if (cell._tag === "blank") {
                    return (
                      <td
                        key={cell.key}
                        data-calendar-slot-blank=""
                        className="border bg-muted/10 p-0 align-top"
                      />
                    )
                  }

                  if (loading) {
                    return (
                      <td key={cell.key} className="border p-0 align-top">
                        <div
                          data-calendar-slot-day=""
                          className="flex w-full flex-col items-start p-2 sm:p-3"
                        >
                          <div className="h-6 w-8 rounded-md bg-muted sm:h-9 sm:w-10" />
                          <div className="mt-3 h-3 w-11 rounded bg-muted sm:mt-4" />
                        </div>
                      </td>
                    )
                  }

                  const slot = firstSlotByDay.get(cell.dateKey)
                  const available =
                    slot !== undefined && cell.dateKey >= todayKey
                  const nonBusiness = !isBusinessDay(cell.dateKey, businessDays)
                  const selected = selectedSlotDayKey === cell.dateKey
                  const contentClassName = cn(
                    "flex w-full flex-col items-start p-2 text-left transition-colors sm:p-3",
                    !available && "text-muted-foreground",
                    available &&
                      "cursor-pointer text-foreground hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                    nonBusiness &&
                      "bg-muted/40 text-muted-foreground hover:bg-muted/60",
                    !cell.inVisibleMonth &&
                      !available &&
                      "bg-muted/10 text-muted-foreground/35",
                    selected &&
                      "bg-primary text-primary-foreground shadow-inner hover:bg-primary",
                    readOnly &&
                      available &&
                      "cursor-default hover:bg-transparent",
                    readOnly && selected && "hover:bg-primary",
                  )
                  const dayNumberClassName = cn(
                    "text-2xl font-medium leading-none tracking-wide text-foreground/90 sm:text-4xl",
                    nonBusiness && !selected && "text-muted-foreground/65",
                    selected && "text-primary-foreground",
                  )
                  const timeClassName = cn(
                    "mt-2 text-sm font-medium sm:mt-2.5 sm:text-base",
                    !selected && nonBusiness && "text-muted-foreground",
                    selected && "text-primary-foreground",
                  )
                  const unavailableStyle = !available
                    ? {
                        backgroundColor:
                          "color-mix(in oklch, var(--muted-foreground) 8%, var(--background))",
                      }
                    : undefined
                  const dayNumberStyle = {
                    fontFamily: DAY_NUMBER_FONT_FAMILY,
                    ...(available || selected
                      ? {}
                      : {
                          color:
                            "color-mix(in oklch, var(--muted-foreground) 55%, var(--background))",
                        }),
                  }

                  return (
                    <td key={cell.key} className="border p-0 align-top">
                      {available && slot ? (
                        <button
                          type="button"
                          aria-label={`${formatDateHeading(
                            cell.dateKey,
                            locale,
                          )}, ${formatStartTime(slot, timeZone, locale)}`}
                          aria-pressed={selected}
                          data-calendar-slot-day=""
                          className={contentClassName}
                          disabled={readOnly === true}
                          onClick={() => onSelectDay?.(cell.dateKey, slot)}
                          ref={
                            autoFocus === true &&
                            cell.dateKey === autoFocusDayKey
                              ? autoFocusButtonRef
                              : undefined
                          }
                        >
                          <span
                            className={dayNumberClassName}
                            style={dayNumberStyle}
                          >
                            {cell.day}
                          </span>
                          <span className={timeClassName}>
                            {formatStartTime(slot, timeZone, locale)}
                          </span>
                        </button>
                      ) : (
                        <div
                          data-calendar-slot-day=""
                          className={contentClassName}
                          style={unavailableStyle}
                        >
                          <span
                            className={dayNumberClassName}
                            style={dayNumberStyle}
                          >
                            {cell.day}
                          </span>
                        </div>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

const CalendarSlotSkeletonCalendar = ({
  calendar,
  locale,
  timeZone,
}: {
  readonly calendar?: CalendarSlotCalendarMetadata | undefined
  readonly locale: string
  readonly timeZone: string
}) => {
  const todayKey = dateKeyFromDate(new Date(), timeZone)
  const visibleMonthKey = monthKeyFromDateKey(todayKey)

  return (
    <div aria-busy="true" aria-live="polite" className="space-y-3">
      <CalendarSlotMonthCalendar
        canGoNext={false}
        canGoPrevious={false}
        firstSlotByDay={new Map<string, CalendarSlotFieldItem>()}
        label="Available times"
        locale={locale}
        loading
        timeZone={timeZone}
        todayKey={todayKey}
        visibleMonthKey={visibleMonthKey}
        weekStartsOn={calendar?.weekStartsOn ?? 0}
      />
      <p className="text-sm text-muted-foreground">
        Loading available times...
      </p>
    </div>
  )
}

const useStringFieldState = () => {
  const field = useFieldContext<string>()
  const form = useFormContext()
  const validationErrors = field.state.meta
    .errors as unknown as StandardSchemaV1Issue[]
  const serverError = field.state.meta.errorMap?.onSubmit
  const allErrors: Array<{ message?: string }> = [
    ...validationErrors,
    ...(serverError ? [{ message: serverError as string }] : []),
  ]
  const { isTouched, isDefaultValue } = field.state.meta
  const afterSubmission = form.state.submissionAttempts > 0
  const isInvalid =
    (afterSubmission && allErrors.length > 0) ||
    (isTouched && !isDefaultValue && allErrors.length > 0)

  return {
    field,
    isInvalid,
    allErrors,
    errorId: `${field.name}-error`,
  }
}

export function CalendarSlotField({
  label,
  descriptionHtml,
  emptyMessageHtml,
  loadErrorMessageHtml,
  slots,
  loading,
  error,
  readOnly,
  autoFocus,
  timeZone,
  locale,
  calendar,
  onRetry,
}: CalendarSlotFieldProps) {
  const { field, isInvalid, allErrors, errorId } = useStringFieldState()
  // Slot lists are collapsed to one selectable time per day; the first
  // chronological slot for that date is presented.
  // This value intentionally updates on remount rather than ticking at midnight;
  // the server remains responsible for filtering out stale slot data.
  const todayKey = useMemo(
    () => dateKeyFromDate(new Date(), timeZone),
    [timeZone],
  )
  const [visibleMonthKey, setVisibleMonthKey] = useState<string>(() =>
    monthKeyFromDateKey(todayKey),
  )
  const initializedMonthRef = useRef(false)

  const { firstSlotByDay, sortedSlots } = useMemo(() => {
    const sorted = [...slots].sort(
      (left, right) =>
        new Date(left.startsAt).getTime() - new Date(right.startsAt).getTime(),
    )
    const firstByDay = new Map<string, CalendarSlotFieldItem>()
    for (const slot of sorted) {
      const key = dateKeyFromDate(new Date(slot.startsAt), timeZone)
      if (key < todayKey || firstByDay.has(key)) {
        continue
      }

      firstByDay.set(key, slot)
    }

    return { firstSlotByDay: firstByDay, sortedSlots: sorted }
  }, [slots, timeZone, todayKey])

  const availableDayKeys = useMemo(
    () => [...firstSlotByDay.keys()].sort(),
    [firstSlotByDay],
  )
  const firstAvailableDayKey = availableDayKeys[0]
  const lastAvailableDayKey = availableDayKeys.at(-1)
  const selectedSlot = sortedSlots.find(
    (slot) => slot.value === field.state.value,
  )
  const selectedSlotDayKey = selectedSlot
    ? dateKeyFromDate(new Date(selectedSlot.startsAt), timeZone)
    : undefined
  const startMonthKey = firstAvailableDayKey
    ? monthKeyFromDateKey(firstAvailableDayKey)
    : monthKeyFromDateKey(todayKey)
  const endMonthKey = lastAvailableDayKey
    ? monthKeyFromDateKey(lastAvailableDayKey)
    : startMonthKey
  const autoFocusDayKey = selectedSlotDayKey ?? firstAvailableDayKey

  useEffect(() => {
    const currentValue = field.state.value
    if (
      readOnly ||
      field.state.meta.isTouched ||
      !currentValue ||
      sortedSlots.length === 0
    ) {
      return
    }

    const currentSlot = sortedSlots.find((slot) => slot.value === currentValue)
    if (!currentSlot) {
      field.handleChange("")
      return
    }

    const currentDayKey = dateKeyFromDate(
      new Date(currentSlot.startsAt),
      timeZone,
    )
    const visibleSlot = firstSlotByDay.get(currentDayKey)
    // currentSlot can exist in sortedSlots but be hidden because its day is now
    // in the past and therefore excluded from firstSlotByDay.
    if (!visibleSlot) {
      field.handleChange("")
      return
    }

    if (visibleSlot.value !== currentValue) {
      field.handleChange(visibleSlot.value)
    }
  }, [
    field,
    field.state.meta.isTouched,
    field.state.value,
    firstSlotByDay,
    readOnly,
    sortedSlots,
    timeZone,
  ])

  useEffect(() => {
    const initialDayKey = selectedSlotDayKey ?? firstAvailableDayKey
    if (!initialDayKey) {
      return
    }

    const initialMonthKey = monthKeyFromDateKey(initialDayKey)
    const visibleMonthIsOutsideSlotRange =
      compareMonthKeys(visibleMonthKey, startMonthKey) < 0 ||
      compareMonthKeys(visibleMonthKey, endMonthKey) > 0

    if (!initializedMonthRef.current || visibleMonthIsOutsideSlotRange) {
      setVisibleMonthKey(initialMonthKey)
      initializedMonthRef.current = true
    }
  }, [
    endMonthKey,
    firstAvailableDayKey,
    selectedSlotDayKey,
    startMonthKey,
    visibleMonthKey,
  ])

  const canGoPrevious = compareMonthKeys(visibleMonthKey, startMonthKey) > 0
  const canGoNext = compareMonthKeys(visibleMonthKey, endMonthKey) < 0

  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      {loading ? (
        <CalendarSlotSkeletonCalendar
          calendar={calendar}
          locale={locale}
          timeZone={timeZone}
        />
      ) : error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          <div className="space-y-3">
            <FieldDescription
              className="text-destructive"
              trustedHtml={
                loadErrorMessageHtml ??
                "Available times could not be loaded. Please try again."
              }
            />
            {onRetry ? (
              <button
                type="button"
                className="rounded-md border border-destructive/40 bg-background px-3 py-2 text-sm font-medium text-destructive transition hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={onRetry}
              >
                Try again
              </button>
            ) : null}
          </div>
        </div>
      ) : sortedSlots.length === 0 ? (
        <div className="rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground">
          <FieldDescription
            trustedHtml={emptyMessageHtml ?? "No available times."}
          />
        </div>
      ) : (
        <div
          aria-describedby={isInvalid ? errorId : undefined}
          aria-invalid={isInvalid}
          className="space-y-4"
        >
          <CalendarSlotMonthCalendar
            autoFocus={autoFocus}
            autoFocusDayKey={autoFocusDayKey}
            businessDays={calendar?.businessDays}
            canGoNext={canGoNext}
            canGoPrevious={canGoPrevious}
            firstSlotByDay={firstSlotByDay}
            label={label}
            locale={locale}
            onNextMonth={() =>
              setVisibleMonthKey(addMonthsToMonthKey(visibleMonthKey, 1))
            }
            onPreviousMonth={() =>
              setVisibleMonthKey(addMonthsToMonthKey(visibleMonthKey, -1))
            }
            onSelectDay={(dayKey, slot) => {
              if (readOnly) {
                return
              }

              field.handleChange(slot.value)
              field.handleBlur()
              setVisibleMonthKey(monthKeyFromDateKey(dayKey))
            }}
            readOnly={readOnly}
            selectedSlotDayKey={selectedSlotDayKey}
            timeZone={timeZone}
            todayKey={todayKey}
            visibleMonthKey={visibleMonthKey}
            weekStartsOn={calendar?.weekStartsOn ?? 0}
          />
        </div>
      )}
      {isInvalid && allErrors.length > 0 && (
        <FieldError errors={allErrors} id={errorId} />
      )}
      {descriptionHtml && <FieldDescription trustedHtml={descriptionHtml} />}
    </Field>
  )
}
