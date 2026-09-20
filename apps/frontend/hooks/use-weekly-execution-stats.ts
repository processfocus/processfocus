import type { Collection } from "@tanstack/db"
import { and, eq, gte, lt } from "@tanstack/db"
import { useLiveQuery } from "@tanstack/react-db"
import { useMemo } from "react"
import type { ExecutionDocType } from "@/lib/collections/execution-collection-provider"

interface WeeklyStats {
  completed: number
  failed: number // Always 0 for now - schema doesn't track failures
}

interface WeeklyExecutionStats {
  thisWeek: WeeklyStats
  lastWeek: WeeklyStats
  isLoading: boolean
}

/**
 * Get the start of the week containing the given date.
 * @param date - The date to find the week start for
 * @param startDayOfWeek - First day of week (0=Sunday, 6=Saturday). Defaults to 0.
 * @internal Exported for testing
 */
export function getWeekStart(date: Date, startDayOfWeek: number = 0): Date {
  const d = new Date(date)
  const dayOfWeek = d.getDay()
  // Calculate days back to reach startDayOfWeek
  const daysBack = (dayOfWeek - startDayOfWeek + 7) % 7
  d.setDate(d.getDate() - daysBack)
  d.setHours(0, 0, 0, 0)
  return d
}

/**
 * Hook to calculate weekly completion stats from RxDB executions.
 * Returns completed/failed counts for this week and last week.
 *
 * Uses database-level filtering to push date range queries to the DB layer.
 * Used by the "Weekly completions" KPI card on the dashboard.
 *
 * @param executionsCollection - The TanStack DB collection of executions
 * @param startDayOfWeek - First day of week (0=Sunday, 6=Saturday). Defaults to 0.
 */
export function useWeeklyExecutionStats(
  executionsCollection: Collection<ExecutionDocType, string>,
  startDayOfWeek: number = 0,
): WeeklyExecutionStats {
  // Calculate week boundaries based on startDayOfWeek
  const { thisWeekStartISO, lastWeekStartISO } = useMemo(() => {
    const now = new Date()
    const thisWeekStart = getWeekStart(now, startDayOfWeek)
    const lastWeekStart = new Date(thisWeekStart)
    lastWeekStart.setDate(lastWeekStart.getDate() - 7)
    return {
      thisWeekStartISO: thisWeekStart.toISOString(),
      lastWeekStartISO: lastWeekStart.toISOString(),
    }
  }, [startDayOfWeek])

  // Query this week's completed executions
  const thisWeekQuery = useLiveQuery((q) =>
    q
      .from({ execution: executionsCollection })
      .where(({ execution }) =>
        and(
          eq(execution.status, "Completed"),
          gte(execution.finishedAt, thisWeekStartISO),
        ),
      )
      .select(({ execution }) => ({ id: execution.id })),
  )

  // Query last week's completed executions
  const lastWeekQuery = useLiveQuery((q) =>
    q
      .from({ execution: executionsCollection })
      .where(({ execution }) =>
        and(
          eq(execution.status, "Completed"),
          gte(execution.finishedAt, lastWeekStartISO),
          lt(execution.finishedAt, thisWeekStartISO),
        ),
      )
      .select(({ execution }) => ({ id: execution.id })),
  )

  return useMemo(() => {
    const isLoading = !thisWeekQuery.isReady || !lastWeekQuery.isReady

    return {
      thisWeek: { completed: thisWeekQuery.data?.length ?? 0, failed: 0 },
      lastWeek: { completed: lastWeekQuery.data?.length ?? 0, failed: 0 },
      isLoading,
    }
  }, [
    thisWeekQuery.isReady,
    thisWeekQuery.data,
    lastWeekQuery.isReady,
    lastWeekQuery.data,
  ])
}
