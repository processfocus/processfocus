import { differenceInHours, formatDistanceToNow, isPast } from "date-fns"
import { useEffect, useState } from "react"
import type { PersistedTaskStatus, TaskStatus } from "./todo-types"

const ONE_HOUR_MS = 60 * 60 * 1000
const ONE_MINUTE_MS = 60 * 1000
const ONE_DAY_MS = 24 * ONE_HOUR_MS
const ONE_WEEK_MS = 7 * ONE_DAY_MS

/**
 * Computes the display status used by Todo views.
 *
 * Stored terminal/correction states win over due-date derivation. Draft and
 * upcoming are frontend-only display states supplied by callers/tests; active
 * persisted Todos become overdue only when their due date is in the past.
 */
export function computeTodoStatus(
  dueAt: string | null | undefined,
  storedStatus?: PersistedTaskStatus | null,
): TaskStatus {
  // Stored Todo status is intentionally small. Draft/upcoming are derived
  // frontend concepts; terminal/correction states must override due-date status.
  if (storedStatus === "Correction Required") return "Correction Required"
  if (storedStatus === "Completed") return "Completed"
  if (!dueAt) return "Active"
  return isPast(new Date(dueAt)) ? "Overdue" : "Active"
}

export function formatDueStatus(
  dueAt: string | null | undefined,
): string | null {
  if (!dueAt) return null
  const dueDate = new Date(dueAt)
  if (isPast(dueDate)) {
    const hours = differenceInHours(new Date(), dueDate)
    if (hours < 1) return "Overdue by less than an hour"
    if (hours < 24) return `Overdue by ${hours} hour${hours !== 1 ? "s" : ""}`
    const days = Math.floor(hours / 24)
    return `Overdue by ${days} day${days !== 1 ? "s" : ""}`
  }
  return `Due ${formatDistanceToNow(dueDate, { addSuffix: true })}`
}

export function formatAssignedAtLabel(assignedAt: string): string {
  const assignedDate = new Date(assignedAt)
  const assignedTime = assignedDate.getTime()
  if (!Number.isFinite(assignedTime)) return "Assigned at unknown time"

  const now = Date.now()
  const diffMs = Math.max(0, now - assignedTime)
  const diffDays = Math.floor(diffMs / ONE_DAY_MS)

  if (diffMs < ONE_MINUTE_MS) return "Assigned just now"
  if (diffDays === 0) {
    const hours = Math.floor(diffMs / ONE_HOUR_MS)
    if (hours > 0) return `Assigned ${hours} hour${hours === 1 ? "" : "s"} ago`

    const minutes = Math.floor(diffMs / ONE_MINUTE_MS)
    return `Assigned ${minutes} minute${minutes === 1 ? "" : "s"} ago`
  }
  if (diffDays === 1) return "Assigned yesterday"
  if (diffDays < 7) return `Assigned ${diffDays} days ago`

  return `Assigned ${assignedDate.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  })}`
}

export function formatAssignedAtExact(assignedAt: string): string {
  const assignedDate = new Date(assignedAt)
  if (!Number.isFinite(assignedDate.getTime()))
    return "Assigned at unknown time"

  return `Assigned ${assignedDate.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })}`
}

export function assignedAtRefreshDelay(assignedAt: string): number | null {
  const assignedTime = new Date(assignedAt).getTime()
  if (!Number.isFinite(assignedTime)) return null

  const diffMs = Math.max(0, Date.now() - assignedTime)
  if (diffMs >= ONE_WEEK_MS) return null

  const intervalMs =
    diffMs < ONE_HOUR_MS
      ? ONE_MINUTE_MS
      : diffMs < ONE_DAY_MS
        ? ONE_HOUR_MS
        : ONE_DAY_MS
  // Add a one-second buffer so the next render lands after the label boundary.
  return intervalMs - (diffMs % intervalMs) + 1000
}

export function isDueWithin24Hours(dueAt: string | null | undefined): boolean {
  if (!dueAt) return false
  const dueDate = new Date(dueAt)
  if (isPast(dueDate)) return false
  const hours = differenceInHours(dueDate, new Date())
  return hours >= 0 && hours < 24
}

/**
 * Hook that triggers a re-render when the next todo becomes overdue.
 * Caps at 1 hour to handle very distant due dates.
 * Timer resets when due-time contents change, keyed by value rather than array
 * identity.
 */
export function useOverdueRefresh(dueTimes: (string | null | undefined)[]) {
  const [, forceRender] = useState(0)
  // ISO due-time strings cannot contain NUL, so this gives a collision-free,
  // intentionally order-sensitive key without depending on array identity.
  const dueTimesKey = dueTimes.map((time) => time ?? "").join("\0")

  useEffect(() => {
    const now = Date.now()
    // Reconstruct from the primitive key so equal due-time contents do not reset
    // the timer.
    const futureDueTimes = dueTimesKey
      .split("\0")
      .filter((t) => t.length > 0)
      .map((t) => new Date(t).getTime())
      .filter((time) => time > now)

    if (futureDueTimes.length === 0) {
      // Nothing due in future - re-check in 1 hour as safety net
      const id = setTimeout(() => forceRender((n) => n + 1), ONE_HOUR_MS)
      return () => clearTimeout(id)
    }

    const nextDue = Math.min(...futureDueTimes)
    const delay = Math.min(nextDue - now + 1000, ONE_HOUR_MS) // +1s buffer, cap at 1 hour

    const id = setTimeout(() => forceRender((n) => n + 1), delay)
    return () => clearTimeout(id)
  }, [dueTimesKey])
}
