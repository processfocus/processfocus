import { format, parseISO } from "date-fns"

/** ISO 8601 date pattern */
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/

/**
 * Format a cell value for display.
 * Auto-detects ISO date strings and formats them as "MMM d, yyyy".
 */
export function formatCellValue(value: unknown): string {
  if (value == null) return ""
  if (typeof value === "string" && ISO_DATE_PATTERN.test(value)) {
    try {
      return format(parseISO(value), "MMM d, yyyy")
    } catch {
      return value
    }
  }
  return String(value)
}
