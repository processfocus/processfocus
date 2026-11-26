import type { StandardSchemaV1Issue } from "@tanstack/react-form"
import { CalendarIcon } from "lucide-react"
import { useRef, useState } from "react"
import {
  DateCalendar,
  calendarDate,
  formatCalendarDay,
  parseCalendarDay,
} from "./date-calendar"
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

export const formatDateInputDay = (date: Date): string =>
  dateFormatter.format(date)

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
  return parseCalendarDay(text)
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
  // Form state stores a date-only calendar choice as UTC midnight for Effect DateTimeUtc.
  return `${formatCalendarDay(date)}T00:00:00.000Z`
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
                  ? formatDateInputDay(selected)
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
            <DateCalendar
              selected={selected}
              month={calendarMonth}
              onMonthChange={setMonth}
              onSelect={(date) => {
                if (!date) return
                field.handleChange(toUtcIsoDate(date))
                field.handleBlur()
                setDraft(undefined)
                setMonth(date)
                setOpen(false)
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
