import { UTCDate } from "@date-fns/utc"
import type { StandardSchemaV1Issue } from "@tanstack/react-form"
import { CalendarIcon } from "lucide-react"
import { useRef, useState } from "react"
import { DayPicker } from "react-day-picker"
import { useFieldContext, useFormContext } from "./form-context"
import { Button } from "./ui/button"
import { Field, FieldDescription, FieldError, FieldLabel } from "./ui/field"
import { Input } from "./ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover"

const dateFormatter = new Intl.DateTimeFormat("en-NZ", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
})

const months = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
]

const utcCalendar = {
  newDate: (year: number, month: number, day: number): Date =>
    new UTCDate(year, month, day),
}

const calendarDate = (
  year: number,
  month: number,
  day: number,
): Date | undefined => {
  const date = new UTCDate(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(0, 0, 0, 0)
  return year >= 1 &&
    year <= 9999 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? date
    : undefined
}

const parseInputDate = (value: string): Date | undefined => {
  const text = value.trim()
  const numeric = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text)
  if (numeric) {
    return calendarDate(
      Number(numeric[3]),
      Number(numeric[2]),
      Number(numeric[1]),
    )
  }
  const named = /^(\d{1,2})\s+([a-z]{3}|sept)\s+(\d{4})$/i.exec(text)
  if (named) {
    const month = (named[2] ?? "").toLowerCase()
    return calendarDate(
      Number(named[3]),
      months.indexOf(month === "sept" ? "sep" : month) + 1,
      Number(named[1]),
    )
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  return iso
    ? calendarDate(Number(iso[1]), Number(iso[2]), Number(iso[3]))
    : undefined
}

const parseFieldDate = (value: unknown): Date | undefined => {
  if (typeof value !== "string" || value.length === 0) return undefined
  if (!/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/.test(value)) return undefined

  // Calendar validity must not depend on skipped days in the browser's timezone.
  return parseInputDate(value.slice(0, 10))
}

export const validateDateField = ({
  value,
}: {
  value: unknown
}): StandardSchemaV1Issue | undefined => {
  // The form schema owns whether an empty date is required or optional.
  if (value === undefined || value === null) return undefined
  return parseFieldDate(value)
    ? undefined
    : {
        message: "Please enter a valid date (DD/MM/YYYY).",
      }
}

const toUtcIsoDate = (date: Date): string => {
  const year = String(date.getUTCFullYear()).padStart(4, "0")
  const month = String(date.getUTCMonth() + 1).padStart(2, "0")
  const day = String(date.getUTCDate()).padStart(2, "0")
  // Form state stores a date-only calendar choice as UTC midnight for Effect DateTimeUtc.
  return `${year}-${month}-${day}T00:00:00.000Z`
}

export const normalizeDateFieldValue = (value: unknown): unknown => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return value
  const date = parseInputDate(value)
  return date ? toUtcIsoDate(date) : value
}

export function DateField({
  label,
  descriptionHtml,
  autoFocus,
  readOnly,
}: {
  label: string
  descriptionHtml?: string | undefined | null
  autoFocus?: boolean
  readOnly?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [month, setMonth] = useState<Date>()
  const [draft, setDraft] = useState<{
    value: string | undefined
    text: string
  }>()
  const inputRef = useRef<HTMLInputElement>(null)
  const field = useFieldContext<string | undefined>()
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
  const errorId = `${field.name}-error`
  const selected = parseFieldDate(field.state.value)
  const calendarMonth = month ?? selected
  const now = new Date()
  // Highlight the user's local "today", while doing calendar arithmetic in UTC.
  const today = calendarDate(
    now.getFullYear(),
    now.getMonth() + 1,
    now.getDate(),
  )

  return (
    <Field>
      <FieldLabel htmlFor={field.name}>{label}</FieldLabel>
      <Popover open={open} onOpenChange={setOpen}>
        <div className="relative">
          <Input
            ref={inputRef}
            id={field.name}
            name={field.name}
            type="text"
            value={
              draft && draft.value === field.state.value
                ? draft.text
                : selected
                  ? dateFormatter.format(selected)
                  : (field.state.value ?? "")
            }
            placeholder="DD/MM/YYYY"
            autoFocus={autoFocus}
            readOnly={readOnly}
            aria-invalid={isInvalid}
            aria-describedby={isInvalid ? errorId : undefined}
            className={readOnly ? undefined : "pr-10"}
            onChange={(event) => {
              if (readOnly) return
              const text = event.target.value
              const date = parseInputDate(text)
              const value =
                text.trim() === ""
                  ? undefined
                  : date
                    ? toUtcIsoDate(date)
                    : text
              setDraft({ text, value })
              field.handleChange(value)
              if (date) setMonth(date)
            }}
            onBlur={() => {
              setDraft(undefined)
              field.handleBlur()
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" && !readOnly) {
                event.preventDefault()
                setOpen(true)
              }
            }}
          />
          {readOnly !== true && (
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Choose ${label}`}
                className="absolute top-1/2 right-1 size-7 -translate-y-1/2"
              >
                <CalendarIcon />
              </Button>
            </PopoverTrigger>
          )}
        </div>
        {readOnly !== true && (
          <PopoverContent
            className="w-auto p-3"
            align="end"
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              inputRef.current?.focus()
            }}
          >
            <DayPicker
              mode="single"
              dateLib={utcCalendar}
              {...(today ? { today } : {})}
              selected={selected}
              {...(calendarMonth ? { month: calendarMonth } : {})}
              onMonthChange={setMonth}
              onSelect={(date) => {
                if (!date) return
                field.handleChange(toUtcIsoDate(date))
                field.handleBlur()
                setDraft(undefined)
                setMonth(date)
                setOpen(false)
              }}
              classNames={{
                root: "text-sm",
                months: "flex flex-col gap-4",
                month: "space-y-3",
                caption_label: "font-medium",
                nav: "flex items-center gap-1",
                chevron: "fill-current",
                button_previous:
                  "rounded-md p-2 hover:bg-accent hover:text-accent-foreground",
                button_next:
                  "rounded-md p-2 hover:bg-accent hover:text-accent-foreground",
                weekdays: "grid grid-cols-7 text-muted-foreground",
                weekday: "py-1 text-center text-xs font-medium",
                week: "grid grid-cols-7",
                day: "p-0 text-center",
                day_button:
                  "size-9 rounded-md hover:bg-accent hover:text-accent-foreground disabled:opacity-50",
                selected:
                  "[&_button]:bg-primary [&_button]:text-primary-foreground",
                today: "[&_button]:border [&_button]:border-primary",
                outside: "text-muted-foreground opacity-50",
              }}
            />
          </PopoverContent>
        )}
      </Popover>
      {isInvalid && allErrors.length > 0 && (
        <FieldError errors={allErrors} id={errorId} />
      )}
      {descriptionHtml && <FieldDescription trustedHtml={descriptionHtml} />}
    </Field>
  )
}
