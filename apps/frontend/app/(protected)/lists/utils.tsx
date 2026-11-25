import { DateTimeDisplay } from "@pf/shadcn-components/date-time-display"

/** ISO 8601 date pattern */
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/

/**
 * Format a cell value for display.
 * ISO calendar dates retain their day; ISO date/times represent instants.
 */
export function formatCellValue(value: unknown) {
  if (value == null) return ""
  if (typeof value === "string" && ISO_DATE_PATTERN.test(value)) {
    return <DateTimeDisplay kind="timestamp" value={value} />
  }
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return <DateTimeDisplay kind="calendar-date" value={value} />
  }
  return String(value)
}
