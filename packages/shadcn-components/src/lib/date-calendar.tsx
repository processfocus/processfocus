import { UTCDate } from "@date-fns/utc"
import { DayPicker, type OnSelectHandler } from "react-day-picker"

const utcCalendar = {
  newDate: (year: number, month: number, day: number): Date =>
    new UTCDate(year, month, day),
}

export const calendarDate = (
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

export const formatCalendarDay = (date: Date): string => {
  const year = String(date.getUTCFullYear()).padStart(4, "0")
  const month = String(date.getUTCMonth() + 1).padStart(2, "0")
  const day = String(date.getUTCDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

export const parseCalendarDay = (value: string): Date | undefined => {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  return iso
    ? calendarDate(Number(iso[1]), Number(iso[2]), Number(iso[3]))
    : undefined
}

export function DateCalendar({
  selected,
  month,
  defaultMonth,
  onMonthChange,
  onSelect,
}: {
  selected: Date | undefined
  month?: Date | undefined
  defaultMonth?: Date | undefined
  onMonthChange?: (month: Date) => void
  onSelect: OnSelectHandler<Date | undefined>
}) {
  const now = new Date()
  // Highlight the user's local "today", while doing calendar arithmetic in UTC.
  const today = calendarDate(
    now.getFullYear(),
    now.getMonth() + 1,
    now.getDate(),
  )
  return (
    <DayPicker
      mode="single"
      dateLib={utcCalendar}
      {...(today ? { today } : {})}
      {...(month ? { month } : {})}
      {...(defaultMonth ? { defaultMonth } : {})}
      selected={selected}
      {...(onMonthChange ? { onMonthChange } : {})}
      onSelect={onSelect}
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
        selected: "[&_button]:bg-primary [&_button]:text-primary-foreground",
        today: "[&_button]:border [&_button]:border-primary",
        outside: "text-muted-foreground opacity-50",
      }}
    />
  )
}
