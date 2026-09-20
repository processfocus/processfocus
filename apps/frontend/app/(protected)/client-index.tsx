"use client"

import { type Collection, eq, or } from "@tanstack/db"
import { useLiveQuery } from "@tanstack/react-db"
import { Suspense, use, useMemo } from "react"
import {
  type DashboardMetrics,
  DashboardSection,
  type RoleLoadItem,
} from "@/components/DashboardSection"
import { DashboardSkeleton } from "@/components/dashboard-skeleton"
import { MobileHomeSwitchboard } from "@/components/mobile-home-switchboard"
import { useOrgSettings } from "@/components/org-settings-provider"
import { useIsMobile } from "@/hooks/use-mobile"
import { useWeeklyExecutionStats } from "@/hooks/use-weekly-execution-stats"
import {
  type ExecutionDocType,
  useExecutionCollection,
} from "@/lib/collections/execution-collection-provider"
import {
  type ProcessDocType,
  useProcessCollection,
} from "@/lib/collections/process-collection-provider"
import {
  TodoCollectionProvider,
  type TodoDocType,
  useTodoCollection,
} from "@/lib/collections/todo-collection-provider"
import { getMobileHomeViewModel } from "@/lib/mobile-home-view-model"
import {
  type SlaBucket,
  type TrendPoint,
  executions as mockExecutions,
} from "@/lib/mock-data"
import { computeTodoStatus } from "@/lib/todo-utils"

/** Type guard to check if a value is a non-null string */
const isString = (value: string | null | undefined): value is string =>
  typeof value === "string"

function DashboardInner({
  processCollectionPromise,
  executionCollectionPromise,
  todoCollectionPromise,
}: {
  processCollectionPromise: Promise<Collection<ProcessDocType, string>>
  executionCollectionPromise: Promise<Collection<ExecutionDocType, string>>
  todoCollectionPromise: Promise<Collection<TodoDocType, string>>
}) {
  "use memo"

  // Suspend until collections are ready
  const processesCollection = use(processCollectionPromise)
  const executionsCollection = use(executionCollectionPromise)
  const todosCollection = use(todoCollectionPromise)

  // Get org settings for week start day
  const { startDayOfWeek } = useOrgSettings()

  // Calculate weekly completion stats for KPI card
  const weeklyStats = useWeeklyExecutionStats(
    executionsCollection,
    startDayOfWeek,
  )

  // Fetch processes using TanStack DB live query
  const processesQuery = useLiveQuery((q) =>
    q.from({ process: processesCollection }).select(({ process }) => ({
      id: process.id,
      updatedAt: process.updatedAt,
      name: process.name,
      path: process.path,
      activeInstances: process.activeInstances,
      category: process.category,
      duration: process.duration,
      formFieldCount: process.formFieldCount,
      purpose: process.purpose,
      isFavorite: process.isFavorite,
      orgUnit: process.orgUnit,
      startStepPath: process.startStepPath,
    })),
  )

  // Fetch recent completed executions for live dashboard section
  const liveExecutionsQuery = useLiveQuery((q) =>
    q
      .from({ execution: executionsCollection })
      .where(({ execution }) =>
        or(
          eq(execution.status, "Completed"),
          eq(execution.status, "Abandoned"),
          eq(execution.status, "Failed"),
        ),
      )
      .orderBy(({ execution }) => execution.finishedAt, "desc")
      .limit(5)
      .select(({ execution }) => ({
        id: execution.id,
        processName: execution.processName,
        status: execution.status,
        durationMs: execution.durationMs,
        finishedAt: execution.finishedAt,
        slaTargetAt: execution.slaTargetAt,
      })),
  )

  // Fetch all executions for metrics (including SLA fields for running executions)
  const allExecutionsQuery = useLiveQuery((q) =>
    q.from({ execution: executionsCollection }).select(({ execution }) => ({
      id: execution.id,
      status: execution.status,
      finishedAt: execution.finishedAt,
      slaWarningAt: execution.slaWarningAt,
      slaTargetAt: execution.slaTargetAt,
    })),
  )

  // Fetch todos for task metrics
  const todosQuery = useLiveQuery((q) =>
    q.from({ todo: todosCollection }).select(({ todo }) => ({
      id: todo.id,
      dueAt: todo.dueAt,
      status: todo.status,
      priority: todo.priority,
      role: todo.role,
    })),
  )

  const isLoading =
    !processesQuery.isReady ||
    !liveExecutionsQuery.isReady ||
    !allExecutionsQuery.isReady ||
    !todosQuery.isReady ||
    weeklyStats.isLoading

  // Transform weekly stats to TrendPoint format for the KPI card
  // DashboardSection expects trend[length-1] as "latest", trend[length-2] as "previous"
  const { thisWeek, lastWeek } = weeklyStats
  const liveTrend: TrendPoint[] = [
    {
      label: "Last week",
      completed: lastWeek.completed,
      failed: lastWeek.failed,
      slaBreachRate: 0,
    },
    {
      label: "This week",
      completed: thisWeek.completed,
      failed: thisWeek.failed,
      slaBreachRate: 0,
    },
  ]

  const dashboardSummary = useMemo(() => {
    const processes: ProcessDocType[] = processesQuery.data ?? []
    const allExecutions = allExecutionsQuery.data ?? []
    const todos = todosQuery.data ?? []
    const todoStatuses = todos.map((todo) =>
      computeTodoStatus(todo.dueAt, todo.status),
    )
    const now = Date.now()

    // Count executions by status from live data
    const runningExecutions = allExecutions.filter(
      (exec) => exec.status === "Running",
    )
    // Note: The execution schema only has "Running" | "Completed" status,
    // so we don't have paused/failed statuses in live data
    const completedExecutions = allExecutions.filter(
      (exec) => exec.status === "Completed",
    )
    const totalExecutions = allExecutions.length

    // Compute SLA status for running executions that have SLA configured
    // Both slaTargetAt and slaWarningAt are computed by backend (slaWarningAt defaults to 80%)
    const runningWithSla = runningExecutions.filter(
      (
        exec,
      ): exec is typeof exec & { slaTargetAt: string; slaWarningAt: string } =>
        isString(exec.slaTargetAt) && isString(exec.slaWarningAt),
    )
    const slaCounts = runningWithSla.reduce(
      (counts, exec) => {
        const targetAt = new Date(exec.slaTargetAt).getTime()
        const warningAt = new Date(exec.slaWarningAt).getTime()

        if (now >= targetAt) {
          return {
            breached: counts.breached + 1,
            onTrack: counts.onTrack,
            warning: counts.warning,
          }
        }

        if (now >= warningAt) {
          return {
            breached: counts.breached,
            onTrack: counts.onTrack,
            warning: counts.warning + 1,
          }
        }

        return {
          breached: counts.breached,
          onTrack: counts.onTrack + 1,
          warning: counts.warning,
        }
      },
      { breached: 0, onTrack: 0, warning: 0 },
    )
    const totalWithSla = runningWithSla.length
    const { onTrack, warning, breached } = slaCounts

    // Calculate SLA distribution percentages for running executions
    // Round first two, compute third as remainder to ensure sum is 100%
    const slaDistribution: SlaBucket[] =
      totalWithSla > 0
        ? (() => {
            const onTrackPct = Math.round((onTrack / totalWithSla) * 100)
            const warningPct = Math.round((warning / totalWithSla) * 100)
            const breachedPct = 100 - onTrackPct - warningPct
            return [
              {
                label: "On track",
                percentage: onTrackPct,
                tone: "good" as const,
              },
              {
                label: "Warning",
                percentage: warningPct,
                tone: "warn" as const,
              },
              {
                label: "Breached",
                percentage: breachedPct,
                tone: "bad" as const,
              },
            ]
          })()
        : [
            { label: "On track", percentage: 0, tone: "good" as const },
            { label: "Warning", percentage: 0, tone: "warn" as const },
            { label: "Breached", percentage: 0, tone: "bad" as const },
          ]

    // SLA compliance for running executions (those not yet breached)
    const slaCompliance =
      totalWithSla > 0
        ? Math.round(((totalWithSla - breached) / totalWithSla) * 100)
        : 100

    const avgCycleTimeHours = 0

    // Calculate role load from live todos
    const roleTotals = todos.reduce<Record<string, number>>((acc, todo) => {
      acc[todo.role] = (acc[todo.role] ?? 0) + 1
      return acc
    }, {})
    const roleLoad = Object.entries(roleTotals)
      .map<RoleLoadItem>(([role, count]) => ({ role, count }))
      .sort((a, b) => b.count - a.count)

    return {
      metrics: {
        activeExecutions: runningExecutions.length,
        pausedExecutions: 0, // Not available in live schema
        completedExecutions: completedExecutions.length,
        failedExecutions: 0, // Not available in live schema
        totalExecutions,
        slaCompliance,
        slaBreaches: breached,
        slaTrackedExecutions: totalWithSla,
        avgCycleTimeHours,
        // Live task metrics from todos collection
        activeTasks: todoStatuses.filter((status) => status === "Active")
          .length,
        correctionTasks: todoStatuses.filter(
          (status) => status === "Correction Required",
        ).length,
        overdueTasks: todoStatuses.filter((status) => status === "Overdue")
          .length,
        draftTasks: todoStatuses.filter((status) => status === "Draft").length,
        upcomingTasks: todoStatuses.filter((status) => status === "Upcoming")
          .length,
        highPriorityTasks: todos.filter((todo) => todo.priority === "High")
          .length,
        processesRequiringForm: processes.filter(
          (process) => (process.formFieldCount ?? 0) > 0,
        ).length,
        immediateProcesses: processes.filter(
          (process) => (process.formFieldCount ?? 0) === 0,
        ).length,
        favoriteProcesses: processes.filter((process) => process.isFavorite)
          .length,
      } satisfies DashboardMetrics,
      roleLoad,
      slaDistribution,
    }
  }, [processesQuery.data, allExecutionsQuery.data, todosQuery.data])

  if (isLoading) {
    return <DashboardSkeleton />
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <DashboardSection
        metrics={dashboardSummary.metrics}
        trend={liveTrend}
        sla={dashboardSummary.slaDistribution}
        roleLoad={dashboardSummary.roleLoad}
        recentExecutions={mockExecutions}
        liveRecentExecutions={liveExecutionsQuery.data ?? []}
      />
    </div>
  )
}

function MobileHomeInner({
  todoCollectionPromise,
}: {
  todoCollectionPromise: Promise<Collection<TodoDocType, string>>
}) {
  "use memo"

  const todosCollection = use(todoCollectionPromise)
  const todosQuery = useLiveQuery((q) =>
    q.from({ todo: todosCollection }).select(({ todo }) => ({
      id: todo.id,
      status: todo.status,
    })),
  )

  if (!todosQuery.isReady) {
    return <DashboardSkeleton />
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <MobileHomeSwitchboard
        viewModel={getMobileHomeViewModel(todosQuery.data ?? [])}
      />
    </div>
  )
}

function IndexContent() {
  const isMobile = useIsMobile()
  const { collectionPromise: processCollectionPromise } = useProcessCollection()
  const { collectionPromise: executionCollectionPromise } =
    useExecutionCollection()
  const { collectionPromise: todoCollectionPromise } = useTodoCollection()

  return (
    <Suspense fallback={<DashboardSkeleton />}>
      {isMobile ? (
        <MobileHomeInner todoCollectionPromise={todoCollectionPromise} />
      ) : (
        <DashboardInner
          processCollectionPromise={processCollectionPromise}
          executionCollectionPromise={executionCollectionPromise}
          todoCollectionPromise={todoCollectionPromise}
        />
      )}
    </Suspense>
  )
}

export default function Index() {
  return (
    <TodoCollectionProvider>
      <IndexContent />
    </TodoCollectionProvider>
  )
}
