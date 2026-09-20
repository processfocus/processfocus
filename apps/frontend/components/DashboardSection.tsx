import { useMocks } from "./mocks-provider"
import type { Execution, SlaBucket, TrendPoint } from "@/lib/mock-data"
import { cn } from "@/lib/utils"

/** Type guard to check if a value is a non-empty string */
const isNonEmptyString = (value: string | null | undefined): value is string =>
  typeof value === "string" && value.length > 0

export interface RoleLoadItem {
  role: string
  count: number
}

/** Shape of live execution data from RxDB */
interface LiveExecution {
  id: string
  processName: string
  status: string
  durationMs: number | null | undefined
  finishedAt: string | null | undefined
  slaTargetAt: string | null | undefined
}

export interface DashboardMetrics {
  activeExecutions: number
  pausedExecutions: number
  completedExecutions: number
  failedExecutions: number
  totalExecutions: number
  slaCompliance: number
  slaBreaches: number
  slaTrackedExecutions: number // Running executions with SLA configured
  avgCycleTimeHours: number
  activeTasks: number
  correctionTasks: number
  overdueTasks: number
  draftTasks: number
  upcomingTasks: number
  highPriorityTasks: number
  processesRequiringForm: number
  immediateProcesses: number
  favoriteProcesses: number
}

const executionStatusTheme = {
  Running:
    "bg-sky-100 text-sky-700 border border-sky-200 dark:bg-sky-500/10 dark:text-sky-300 dark:border-sky-500/30",
  Paused:
    "bg-amber-100 text-amber-700 border border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/30",
  Completed:
    "bg-emerald-100 text-emerald-700 border border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/30",
  Failed:
    "bg-rose-100 text-rose-700 border border-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:border-rose-500/30",
  Abandoned:
    "bg-slate-100 text-slate-600 border border-slate-200 dark:bg-slate-500/10 dark:text-slate-300 dark:border-slate-500/30",
}

function formatCycleTime(cycleTimeHours?: number): string {
  if (typeof cycleTimeHours !== "number" || Number.isNaN(cycleTimeHours)) {
    return "—"
  }
  if (cycleTimeHours < 24) {
    return `${cycleTimeHours}h`
  }
  const days = Math.round((cycleTimeHours / 24) * 10) / 10
  return `${days}d`
}

export function DashboardSection({
  metrics,
  trend,
  sla,
  roleLoad,
  recentExecutions,
  liveRecentExecutions,
}: {
  metrics: DashboardMetrics
  trend: TrendPoint[]
  sla: SlaBucket[]
  roleLoad: RoleLoadItem[]
  recentExecutions: Execution[]
  liveRecentExecutions?: LiveExecution[]
}) {
  const { showMocks } = useMocks()
  const latest = trend[trend.length - 1]
  const previous = trend.length > 1 ? trend[trend.length - 2] : undefined
  const completionDelta =
    previous && latest ? latest.completed - previous.completed : 0
  const completionTone: "positive" | "negative" | "neutral" =
    previous && latest
      ? completionDelta >= 0
        ? "positive"
        : "negative"
      : "neutral"
  const slaDelta =
    previous && latest
      ? Math.round(previous.slaBreachRate - latest.slaBreachRate)
      : 0
  const slaTone: "positive" | "negative" | "neutral" =
    previous && latest ? (slaDelta >= 0 ? "positive" : "negative") : "neutral"
  const openTasks =
    metrics.activeTasks + metrics.correctionTasks + metrics.overdueTasks
  const totalTasks =
    metrics.activeTasks +
    metrics.correctionTasks +
    metrics.overdueTasks +
    metrics.draftTasks +
    metrics.upcomingTasks

  return (
    <section className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          title="Weekly completions"
          value={latest ? String(latest.completed) : "0"}
          helper={latest ? `Failed ${latest.failed}` : undefined}
          delta={previous && latest ? completionDelta : undefined}
          deltaLabel="vs prev week"
          tone={completionTone}
        />
        <KpiCard
          title="SLA compliance"
          value={`${metrics.slaCompliance}%`}
          helper={`Breaches ${metrics.slaBreaches} of ${metrics.totalExecutions}`}
          delta={previous && latest ? slaDelta : undefined}
          deltaLabel="pts vs prev week"
          tone={slaTone}
        />
        <KpiCard
          title="In progress executions"
          value={String(metrics.activeExecutions + metrics.pausedExecutions)}
          helper={`Active ${metrics.activeExecutions} • Paused ${metrics.pausedExecutions}`}
        />
        <KpiCard
          title="Open tasks"
          value={String(openTasks)}
          helper={`High priority ${metrics.highPriorityTasks}`}
          meta={`Corrections ${metrics.correctionTasks} • Overdue ${metrics.overdueTasks} • Drafts ${metrics.draftTasks}`}
        />
      </div>
      <div className="grid gap-6 xl:grid-cols-[2fr_1fr]">
        <ThroughputPanel
          data={trend}
          avgCycleTimeHours={metrics.avgCycleTimeHours}
        />
        <div className="space-y-6">
          <SlaHealthCard
            sla={sla}
            compliance={metrics.slaCompliance}
            breaches={metrics.slaBreaches}
            totalExecutions={metrics.slaTrackedExecutions}
          />
          <RoleLoadCard roleLoad={roleLoad} totalTasks={totalTasks} />
        </div>
      </div>
      {liveRecentExecutions && liveRecentExecutions.length > 0 && (
        <LiveRecentExecutionsTable executions={liveRecentExecutions} />
      )}
      {showMocks && <RecentExecutionsTable executions={recentExecutions} />}
    </section>
  )
}

function KpiCard({
  title,
  value,
  helper,
  meta,
  delta,
  deltaLabel,
  tone = "neutral",
}: {
  title: string
  value: string
  helper?: string | undefined
  meta?: string | undefined
  delta?: number | undefined
  deltaLabel?: string | undefined
  tone?: "positive" | "negative" | "neutral" | undefined
}) {
  const toneText =
    tone === "positive"
      ? "text-emerald-600 dark:text-emerald-300"
      : tone === "negative"
        ? "text-rose-600 dark:text-rose-300"
        : "text-slate-500 dark:text-slate-400"
  const arrow =
    delta === undefined ? "" : delta > 0 ? "▲" : delta < 0 ? "▼" : "▬"
  const magnitude = delta === undefined ? "" : String(Math.abs(delta))
  const deltaText =
    delta === undefined || !deltaLabel
      ? ""
      : `${arrow} ${magnitude} ${deltaLabel}`.trim()

  return (
    <div className="flex flex-col justify-between rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:shadow-md dark:border-slate-800 dark:bg-slate-900/70">
      <div>
        <p className="text-sm font-semibold text-slate-500 dark:text-slate-400">
          {title}
        </p>
        <p className="mt-2 text-3xl font-semibold text-slate-900 dark:text-slate-50">
          {value}
        </p>
        {helper && (
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {helper}
          </p>
        )}
        {meta && (
          <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
            {meta}
          </p>
        )}
      </div>
      {delta !== undefined && deltaLabel && (
        <p className={cn("mt-4 text-xs font-semibold", toneText)}>
          {deltaText}
        </p>
      )}
    </div>
  )
}

function ThroughputPanel({
  data,
  avgCycleTimeHours,
}: {
  data: TrendPoint[]
  avgCycleTimeHours: number
}) {
  const maxTotal = Math.max(
    ...data.map((point) => point.completed + point.failed),
    1,
  )
  const latestBreach = data[data.length - 1]?.slaBreachRate ?? 0
  const previousBreach =
    data.length > 1 ? (data[data.length - 2]?.slaBreachRate ?? null) : null
  const breachDelta =
    previousBreach === null ? null : latestBreach - previousBreach
  const breachTone =
    breachDelta === null
      ? "text-slate-500 dark:text-slate-400"
      : breachDelta <= 0
        ? "text-emerald-600 dark:text-emerald-300"
        : "text-rose-600 dark:text-rose-300"
  const cycleTimeDisplay =
    avgCycleTimeHours === 0
      ? "—"
      : `${Math.round((avgCycleTimeHours / 24) * 10) / 10}d`

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            Throughput
          </h3>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Weekly completions with failure overlay
          </p>
        </div>
        <span className="inline-flex items-center gap-2 rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-500 dark:border-slate-700 dark:text-slate-300">
          Avg cycle time
          <span className="text-base font-semibold text-slate-900 dark:text-slate-100">
            {cycleTimeDisplay}
          </span>
        </span>
      </div>
      <div className="mt-4 flex h-48 items-end gap-4">
        {data.length === 0 ? (
          <div className="flex h-full w-full items-center justify-center rounded-xl border border-dashed border-slate-300 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
            No throughput data yet
          </div>
        ) : (
          data.map((point) => {
            const total = point.completed + point.failed
            const completedHeight =
              total === 0 ? 0 : (point.completed / maxTotal) * 100
            const failedHeight =
              total === 0 ? 0 : (point.failed / maxTotal) * 100
            return (
              <div
                key={point.label}
                className="flex flex-1 flex-col items-center gap-2 text-xs"
              >
                <div className="flex h-36 w-full flex-col-reverse overflow-hidden rounded-lg bg-slate-100 dark:bg-slate-800/60">
                  <div
                    role="img"
                    className="bg-blue-500"
                    style={{
                      height: `${Math.max(completedHeight, point.completed > 0 ? 6 : 0)}%`,
                    }}
                    aria-label={`${point.completed} completed`}
                  />
                  <div
                    role="img"
                    className="bg-rose-400"
                    style={{
                      height: `${Math.max(failedHeight, point.failed > 0 ? 4 : 0)}%`,
                    }}
                    aria-label={`${point.failed} failed`}
                  />
                </div>
                <span className="font-semibold text-slate-600 dark:text-slate-300">
                  {point.label}
                </span>
                <span className="text-[11px] text-slate-500 dark:text-slate-400">
                  {point.completed} done
                </span>
              </div>
            )
          })
        )}
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500 dark:text-slate-400">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-blue-500" />
          Completed
        </div>
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-rose-400" />
          Failed
        </div>
        <div className={cn("font-semibold", breachTone)}>
          Breach rate {latestBreach}%
          {breachDelta !== null && (
            <span className="ml-1">
              {breachDelta === 0 ? "▬" : breachDelta < 0 ? "▼" : "▲"}{" "}
              {Math.abs(breachDelta)} pts
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

function SlaHealthCard({
  sla,
  compliance,
  breaches,
  totalExecutions,
}: {
  sla: SlaBucket[]
  compliance: number
  breaches: number
  totalExecutions: number
}) {
  const toneClasses = {
    good: "bg-emerald-500",
    warn: "bg-amber-400",
    bad: "bg-rose-500",
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900/70">
      <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
        SLA health
      </h3>
      <p className="text-sm text-slate-500 dark:text-slate-400">
        Distribution of current executions
      </p>
      <div className="mt-4 h-3 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
        {sla.map((bucket) => (
          <div
            key={bucket.label}
            className={cn("h-full", toneClasses[bucket.tone])}
            style={{ width: `${bucket.percentage}%` }}
          />
        ))}
      </div>
      <ul className="mt-4 space-y-2 text-sm text-slate-600 dark:text-slate-300">
        {sla.map((bucket) => (
          <li key={bucket.label} className="flex items-center justify-between">
            <span className="flex items-center gap-2">
              <span
                className={cn(
                  "h-2.5 w-2.5 rounded-full",
                  toneClasses[bucket.tone],
                )}
              />
              {bucket.label}
            </span>
            <span>{bucket.percentage}%</span>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-xs text-slate-500 dark:text-slate-400">
        Compliance {compliance}% • {breaches} of {totalExecutions} executions
        breached SLA.
      </p>
    </div>
  )
}

function RoleLoadCard({
  roleLoad,
  totalTasks,
}: {
  roleLoad: RoleLoadItem[]
  totalTasks: number
}) {
  const displayed = roleLoad.slice(0, 5)
  const maxCount = displayed.reduce((max, item) => Math.max(max, item.count), 1)

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900/70">
      <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
        Workload by role
      </h3>
      <p className="text-sm text-slate-500 dark:text-slate-400">
        Top contributors across open work
      </p>
      <ul className="mt-4 space-y-3">
        {displayed.length === 0 ? (
          <li className="text-sm text-slate-500 dark:text-slate-400">
            No tasks assigned yet.
          </li>
        ) : (
          displayed.map((item) => (
            <li key={item.role} className="space-y-2">
              <div className="flex items-center justify-between text-sm text-slate-600 dark:text-slate-300">
                <span>{item.role}</span>
                <span>{item.count} tasks</span>
              </div>
              <div className="h-2 w-full rounded-full bg-slate-200 dark:bg-slate-800">
                <div
                  className="h-2 rounded-full bg-blue-500"
                  style={{ width: `${(item.count / maxCount) * 100}%` }}
                />
              </div>
            </li>
          ))
        )}
      </ul>
      <p className="mt-4 text-xs text-slate-500 dark:text-slate-400">
        Tracking {totalTasks} tasks across {roleLoad.length} roles.
      </p>
    </div>
  )
}

function formatRelativeTime(isoString: string | null | undefined): string {
  if (!isoString) return "—"
  const date = new Date(isoString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (diffDays === 0) return "Today"
  if (diffDays === 1) return "Yesterday"
  if (diffDays < 7) return `${diffDays} days ago`
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`
  return date.toLocaleDateString()
}

function formatLiveCycleTime(durationMs: number | null | undefined): string {
  if (
    durationMs === null ||
    durationMs === undefined ||
    Number.isNaN(durationMs)
  )
    return "—"
  const hours = Math.round(durationMs / (1000 * 60 * 60))
  if (hours < 24) return `${hours}h`
  const days = Math.round((hours / 24) * 10) / 10
  return `${days}d`
}

function LiveRecentExecutionsTable({
  executions,
}: {
  executions: LiveExecution[]
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900/70">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            Recent outcomes
          </h3>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Latest finished executions from RxDB
          </p>
        </div>
        <a
          href="/executions"
          className="rounded-full border border-slate-200 px-3 py-1 text-sm text-slate-600 hover:border-slate-300 hover:text-slate-800 dark:border-slate-700 dark:text-slate-300 dark:hover:border-slate-600 dark:hover:text-slate-200"
        >
          View all
        </a>
      </div>
      <div className="mt-4 overflow-x-auto">
        <table className="min-w-full border-separate border-spacing-y-2 text-sm">
          <thead>
            <tr className="text-left text-xs tracking-wide text-slate-400 uppercase dark:text-slate-500">
              <th className="px-3 py-2">Process</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Cycle time</th>
              <th className="px-3 py-2">SLA</th>
              <th className="px-3 py-2">Finished</th>
            </tr>
          </thead>
          <tbody>
            {executions.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="px-3 py-6 text-center text-sm text-slate-500 dark:text-slate-400"
                >
                  No recent executions yet.
                </td>
              </tr>
            ) : (
              executions.map((exec) => (
                <tr
                  key={exec.id}
                  className="rounded-xl border border-slate-200 bg-slate-50/50 text-slate-600 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-300"
                >
                  <td className="rounded-l-xl px-3 py-3">
                    <div className="font-semibold text-slate-900 dark:text-slate-100">
                      {exec.processName}
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      {exec.id}
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold",
                        executionStatusTheme[
                          exec.status as keyof typeof executionStatusTheme
                        ] ?? executionStatusTheme.Completed,
                      )}
                    >
                      {exec.status}
                    </span>
                  </td>
                  <td className="px-3 py-3">
                    {formatLiveCycleTime(exec.durationMs)}
                  </td>
                  <td className="px-3 py-3">
                    {(() => {
                      // Need both SLA target and finish time to determine breach status
                      if (
                        !isNonEmptyString(exec.slaTargetAt) ||
                        !isNonEmptyString(exec.finishedAt)
                      ) {
                        return (
                          <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                            N/A
                          </span>
                        )
                      }
                      const finishedMs = new Date(exec.finishedAt).getTime()
                      const targetMs = new Date(exec.slaTargetAt).getTime()
                      // Validate both dates parsed correctly
                      if (Number.isNaN(finishedMs) || Number.isNaN(targetMs)) {
                        return (
                          <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                            N/A
                          </span>
                        )
                      }
                      const breached = finishedMs > targetMs
                      return (
                        <span
                          className={cn(
                            "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold",
                            breached
                              ? "bg-rose-100 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300"
                              : "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300",
                          )}
                        >
                          {breached ? "Breached" : "On track"}
                        </span>
                      )
                    })()}
                  </td>
                  <td className="rounded-r-xl px-3 py-3">
                    <div className="text-sm text-slate-600 dark:text-slate-300">
                      {formatRelativeTime(exec.finishedAt)}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function RecentExecutionsTable({ executions }: { executions: Execution[] }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900/70">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            Recent outcomes (Mock data)
          </h3>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Latest completed or failed executions
          </p>
        </div>
        <button
          type="button"
          className="rounded-full border border-slate-200 px-3 py-1 text-sm text-slate-600 hover:border-slate-300 hover:text-slate-800 dark:border-slate-700 dark:text-slate-300 dark:hover:border-slate-600 dark:hover:text-slate-200"
        >
          View all
        </button>
      </div>
      <div className="mt-4 overflow-x-auto">
        <table className="min-w-full border-separate border-spacing-y-2 text-sm">
          <thead>
            <tr className="text-left text-xs tracking-wide text-slate-400 uppercase dark:text-slate-500">
              <th className="px-3 py-2">Process</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Cycle time</th>
              <th className="px-3 py-2">SLA</th>
              <th className="px-3 py-2">Completed</th>
            </tr>
          </thead>
          <tbody>
            {executions.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="px-3 py-6 text-center text-sm text-slate-500 dark:text-slate-400"
                >
                  No recent executions yet.
                </td>
              </tr>
            ) : (
              executions.map((exec) => (
                <tr
                  key={exec.id}
                  className="rounded-xl border border-slate-200 bg-slate-50/50 text-slate-600 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-300"
                >
                  <td className="rounded-l-xl px-3 py-3">
                    <div className="font-semibold text-slate-900 dark:text-slate-100">
                      {exec.processName}
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      {exec.executionId}
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold",
                        executionStatusTheme[exec.status],
                      )}
                    >
                      {exec.status}
                    </span>
                  </td>
                  <td className="px-3 py-3">
                    {formatCycleTime(exec.cycleTimeHours)}
                  </td>
                  <td className="px-3 py-3">
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold",
                        exec.slaBreached
                          ? "bg-rose-100 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300"
                          : "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300",
                      )}
                    >
                      {exec.slaBreached ? "Breached" : "On track"}
                    </span>
                  </td>
                  <td className="rounded-r-xl px-3 py-3">
                    <div className="text-sm text-slate-600 dark:text-slate-300">
                      {exec.completionDate ?? exec.lastActivity}
                    </div>
                    {exec.failureReason && (
                      <p className="mt-1 text-xs text-rose-600 dark:text-rose-300">
                        {exec.failureReason}
                      </p>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
