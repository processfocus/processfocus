import { differenceInHours, isPast } from "date-fns"
import { useEffect, useState } from "react"
import type { PersistedTaskStatus, TaskStatus } from "./todo-types"

const ONE_HOUR_MS = 60 * 60 * 1000

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
