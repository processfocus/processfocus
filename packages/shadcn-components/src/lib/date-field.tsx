import type { StandardSchemaV1Issue } from "@tanstack/react-form"
import { CalendarIcon } from "lucide-react"
import { useState } from "react"
import { DayPicker } from "react-day-picker"
import { useFieldContext, useFormContext } from "./form-context"
import { Button } from "./ui/button"
import { Field, FieldDescription, FieldError, FieldLabel } from "./ui/field"
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover"
import { cn } from "./utils/utils"

const dateFormatter = new Intl.DateTimeFormat("en-NZ", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
})

const parseFieldDate = (value: unknown): Date | undefined => {
  if (typeof value !== "string" || value.length === 0) return undefined
  if (!/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/.test(value)) return undefined

  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

const toUtcIsoDate = (date: Date): string => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  // Form state stores a date-only calendar choice as UTC midnight for Effect DateTimeUtc.
  return `${year}-${month}-${day}T00:00:00.000Z`
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
  const errorId = `${field.name}-error`
  const selected = parseFieldDate(field.state.value)

  return (
    <Field>
      <FieldLabel htmlFor={field.name}>{label}</FieldLabel>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={field.name}
            type="button"
            variant="outline"
            autoFocus={autoFocus}
            disabled={readOnly}
            aria-invalid={isInvalid}
            aria-describedby={isInvalid ? errorId : undefined}
            className={cn(
              "w-full justify-start text-left font-normal",
              !selected && "text-muted-foreground",
            )}
          >
            <CalendarIcon />
            {selected ? dateFormatter.format(selected) : "Pick a date"}
          </Button>
        </PopoverTrigger>
        {readOnly !== true && (
          <PopoverContent className="w-auto p-3" align="start">
            <DayPicker
              mode="single"
              selected={selected}
              onSelect={(date) => {
                if (!date) return
                field.handleChange(toUtcIsoDate(date))
                field.handleBlur()
                setOpen(false)
              }}
              classNames={{
                root: "text-sm",
                months: "flex flex-col gap-4",
                month: "space-y-3",
                caption_label: "font-medium",
                nav: "flex items-center gap-1",
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
