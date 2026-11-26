import { CalendarIcon } from "lucide-react"
import { useRef, useState } from "react"
import {
  DateCalendar,
  formatCalendarDay,
  parseCalendarDay,
} from "./date-calendar"
import { formatDateInputDay } from "./date-field"
import { Button } from "./ui/button"
import { Input } from "./ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover"

export function LocalDateTimeInput({
  id,
  label,
  value,
  disabled,
  required,
  invalid,
  describedBy,
  onChange,
  onBlur,
}: {
  id: string
  label: string
  value: string
  disabled: boolean
  required: boolean
  invalid: boolean
  describedBy: string
  onChange: (value: string) => void
  onBlur: () => void
}) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  // Keep even a partial value in form state so drafts retain either input.
  const [day = "", time = ""] = value.split(" ")
  const selected = parseCalendarDay(day)
  const displayDay = selected ? formatDateInputDay(selected) : "Choose date"
  const change = (nextDay: string, nextTime: string) =>
    onChange(nextDay || nextTime ? `${nextDay} ${nextTime}` : "")

  return (
    <fieldset className="space-y-1" disabled={disabled}>
      <legend className="text-sm font-medium">{label}</legend>
      <div className="flex flex-wrap items-end gap-2">
        <Popover open={!disabled && open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              ref={triggerRef}
              type="button"
              variant="outline"
              aria-label={`${label}: ${displayDay}`}
              aria-invalid={invalid}
              aria-describedby={describedBy}
            >
              <CalendarIcon />
              {displayDay}
            </Button>
          </PopoverTrigger>
          <PopoverContent
            className="w-auto p-3"
            align="start"
            aria-label={`${label}: calendar`}
          >
            <DateCalendar
              selected={selected}
              defaultMonth={selected}
              onSelect={(date) => {
                if (!date) return
                change(formatCalendarDay(date), time)
                onBlur()
                setOpen(false)
              }}
            />
          </PopoverContent>
        </Popover>
        <Input
          id={id}
          name={id}
          type="time"
          step={1}
          value={time}
          className="w-auto"
          aria-label={`${label}: time`}
          aria-required={required}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          onBlur={onBlur}
          onChange={(event) => change(day, event.target.value)}
        />
        {!required && value !== "" && (
          <Button
            type="button"
            variant="ghost"
            aria-label={`Clear ${label}`}
            onClick={() => {
              onChange("")
              triggerRef.current?.focus()
            }}
          >
            Clear
          </Button>
        )}
      </div>
    </fieldset>
  )
}
