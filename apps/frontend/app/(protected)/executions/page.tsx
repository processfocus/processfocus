"use client"

import type { Collection } from "@tanstack/db"
import { useLiveQuery } from "@tanstack/react-db"
import { ChevronLeft } from "lucide-react"
import Image from "next/image"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { Suspense, use, useMemo, useRef, useState } from "react"
import { ExecutionCardMenu } from "./execution-card-menu"
import { useMocks } from "@/components/mocks-provider"
import { ProcessWorkflowLink } from "@/components/process-workflow-link"
import { TabPill } from "@/components/ui/tab-pill"
import { WithoutWaitingBadge } from "@/components/without-waiting-badge"
import { useIsMobile } from "@/hooks/use-mobile"
import {
  type ExecutionDocType,
  useExecutionCollection,
} from "@/lib/collections/execution-collection-provider"
import { type Execution, executions as mockExecutions } from "@/lib/mock-data"
import { cn } from "@/lib/utils"

type ExecutionStatus =
  | "Running"
  | "Completed"
  | "Failed"
  | "Abandoned"
  | "Not started"
type ExecutionTabKey =
  | "in-progress"
  | "completed"
  | "failed"
  | "not-started"
  | "all"
type MockExecutionView = "timeline" | "kanban"
type MockExecutionTabKey = "in-progress" | "completed" | "failed" | "all"

const executionStatusTheme: Record<ExecutionStatus, string> = {
  "Not started":
    "bg-amber-100 text-amber-800 border border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/30",
  Running:
    "bg-sky-100 text-sky-700 border border-sky-200 dark:bg-sky-500/10 dark:text-sky-300 dark:border-sky-500/30",
  Completed:
    "bg-emerald-100 text-emerald-700 border border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/30",
  Failed:
    "bg-rose-100 text-rose-700 border border-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:border-rose-500/30",
  Abandoned:
    "bg-slate-100 text-slate-600 border border-slate-200 dark:bg-slate-500/10 dark:text-slate-400 dark:border-slate-500/30",
}

const mockExecutionStatusTheme = {
  Running:
    "bg-sky-100 text-sky-700 border border-sky-200 dark:bg-sky-500/10 dark:text-sky-300 dark:border-sky-500/30",
  Paused:
    "bg-amber-100 text-amber-700 border border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/30",
  Completed:
    "bg-emerald-100 text-emerald-700 border border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/30",
  Failed:
    "bg-rose-100 text-rose-700 border border-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:border-rose-500/30",
}

const mockExecutionTabFilters: Record<
  MockExecutionTabKey,
  Execution["status"][]
> = {
  "in-progress": ["Running", "Paused"],
  completed: ["Completed"],
  failed: ["Failed"],
  all: ["Running", "Paused", "Completed", "Failed"],
}

const executionTabKeys = [
  "not-started",
  "in-progress",
  "completed",
  "failed",
  "all",
] as const satisfies readonly ExecutionTabKey[]

function parseExecutionTabKey(value: string | null): ExecutionTabKey | null {
  return executionTabKeys.find((key) => key === value) ?? null
}

/**
 * Format timestamp to relative time string
 * Accepts either epoch ms (number) or ISO date string
 */
function formatRelativeTime(timestamp: number | string): string {
  const time =
    typeof timestamp === "string" ? new Date(timestamp).getTime() : timestamp

  if (!Number.isFinite(time) || time <= 0) {
    return "Unknown"
  }

  const now = Date.now()
  const diff = now - time

  if (diff < 0) {
    return "Just now"
  }

  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) return `${days} day${days > 1 ? "s" : ""} ago`
  if (hours > 0) return `${hours} hour${hours > 1 ? "s" : ""} ago`
  if (minutes > 0) return `${minutes} minute${minutes > 1 ? "s" : ""} ago`
  return "Just now"
}

function ExecutionsSkeleton() {
  return (
    <div className="flex-1 overflow-y-auto">
      <section className="space-y-6">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
          <div className="flex items-center justify-center py-12">
            <div className="text-center">
              <output
                className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-blue-600 border-r-transparent motion-reduce:animate-[spin_1.5s_linear_infinite]"
                aria-label="Loading executions"
              />
              <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">
                Loading executions...
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}

// =============================================================================
// LIVE IMPLEMENTATION (using RxDB data)
// =============================================================================

function ExecutionsPageInner({
  collectionPromise,
  initialSelectedExecutionId = null,
  onMobileBack,
}: {
  collectionPromise: Promise<Collection<ExecutionDocType, string>>
  initialSelectedExecutionId?: string | null
  onMobileBack?: () => void
}) {
  "use memo"

  const executionCollection = use(collectionPromise)
  const router = useRouter()
  const searchParams = useSearchParams()
  const isMobile = useIsMobile()
  const defaultTab = initialSelectedExecutionId ? "all" : "in-progress"
  const tab = parseExecutionTabKey(searchParams.get("filter")) ?? defaultTab
  const currentQueryString = searchParams.toString()
  const currentQuerySuffix = currentQueryString ? `?${currentQueryString}` : ""
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(
    null,
  )

  // Live query for all executions, ordered by most recent first
  const executionsQuery = useLiveQuery((q) =>
    q
      .from({ execution: executionCollection })
      .select(({ execution }) => ({
        id: execution.id,
        updatedAt: execution.updatedAt,
        processStateId: execution.processStateId,
        processName: execution.processName,
        withoutWaiting: execution.withoutWaiting ?? false,
        processPath: execution.processPath,
        canAbandonExecution: execution.canAbandonExecution ?? false,
        canRestartExecution: execution.canRestartExecution ?? false,
        status: execution.status,
        failureReason: execution.failureReason,
        notStartedReason: execution.notStartedReason,
        abandonedReason: execution.abandonedReason,
        startedAt: execution.startedAt,
        finishedAt: execution.finishedAt,
        completedSteps: execution.completedSteps,
        totalSteps: execution.totalSteps,
        durationMs: execution.durationMs,
        estimatedCompletionAt: execution.estimatedCompletionAt,
        slaTargetAt: execution.slaTargetAt,
        steps: execution.steps,
      }))
      .orderBy(({ execution }) => execution.startedAt, "desc"),
  )

  const executions = executionsQuery.data ?? []

  const routeSelectedExecution = initialSelectedExecutionId
    ? executions.find(
        (execution) => execution.id === initialSelectedExecutionId,
      )
    : null

  // Count by status
  const runningCount = executions.filter((e) => e.status === "Running").length
  const completedCount = executions.filter(
    (e) => e.status === "Completed",
  ).length
  const failedCount = executions.filter(
    (e) => e.status === "Failed" || e.status === "Abandoned",
  ).length

  // Filter based on tab
  const filtered = (() => {
    switch (tab) {
      case "not-started":
        return executions.filter((e) => e.status === "Not started")
      case "in-progress":
        return executions.filter((e) => e.status === "Running")
      case "completed":
        return executions.filter((e) => e.status === "Completed")
      case "failed":
        return executions.filter(
          (e) => e.status === "Failed" || e.status === "Abandoned",
        )
      default:
        return executions
    }
  })()

  // Selected execution
  const selectedExecution = (() => {
    if (filtered.length === 0) return null

    if (selectedExecutionId) {
      const found = filtered.find((e) => e.id === selectedExecutionId)
      if (found) return found
    }

    if (initialSelectedExecutionId) {
      if (!routeSelectedExecution) return null

      const routeSelection = filtered.find(
        (execution) => execution.id === initialSelectedExecutionId,
      )

      if (routeSelection) return routeSelection
      return isMobile ? routeSelectedExecution : (filtered[0] ?? null)
    }

    return filtered[0] ?? null
  })()

  const handleSelectExecution = (executionId: string) => {
    setSelectedExecutionId(executionId)

    const executionPath = `/executions/${encodeURIComponent(executionId)}${currentQuerySuffix}`

    if (isMobile) {
      router.push(executionPath, { scroll: false })
      return
    }

    router.replace(executionPath, { scroll: false })
  }

  const handleSelectTab = (nextTab: ExecutionTabKey) => {
    const nextSearchParams = new URLSearchParams(searchParams)

    if (nextTab === defaultTab) {
      nextSearchParams.delete("filter")
    } else {
      nextSearchParams.set("filter", nextTab)
    }

    const nextQueryString = nextSearchParams.toString()
    router.replace(
      nextQueryString ? `/executions?${nextQueryString}` : "/executions",
      { scroll: false },
    )
  }

  const handleCloseMobileDetail = () => {
    if (onMobileBack) {
      onMobileBack()
      return
    }

    router.push(`/executions${currentQuerySuffix}`, { scroll: false })
  }

  const isMobileDetailRoute = isMobile && initialSelectedExecutionId !== null
  const isRouteExecutionMissing =
    initialSelectedExecutionId !== null && routeSelectedExecution === null

  if (!executionsQuery.isReady) {
    return <ExecutionsSkeleton />
  }

  return (
    <section className="space-y-6">
      {!isMobileDetailRoute && (
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
          <div className="flex flex-wrap items-center gap-2">
            <TabPill
              label="In Progress"
              count={runningCount}
              active={tab === "in-progress"}
              onClick={() => handleSelectTab("in-progress")}
            />
            <TabPill
              label="Completed"
              count={completedCount}
              active={tab === "completed"}
              onClick={() => handleSelectTab("completed")}
            />
            <TabPill
              label="Failed"
              count={failedCount}
              active={tab === "failed"}
              onClick={() => handleSelectTab("failed")}
            />
            <TabPill
              label="All"
              count={executions.length}
              active={tab === "all"}
              onClick={() => handleSelectTab("all")}
            />
            <TabPill
              label="Not started"
              count={
                executions.filter((e) => e.status === "Not started").length
              }
              active={tab === "not-started"}
              onClick={() => handleSelectTab("not-started")}
            />
          </div>
        </div>
      )}

      {isMobileDetailRoute ? (
        selectedExecution ? (
          <MobileExecutionDetail
            execution={selectedExecution}
            onBack={handleCloseMobileDetail}
          />
        ) : (
          <EmptyState
            title="Execution not found"
            description="This execution is no longer available or you no longer have access to it."
          />
        )
      ) : filtered.length === 0 ? (
        <EmptyState
          title="No executions in this view"
          description="Adjust filters or start a process from the catalog to see live executions."
        />
      ) : isMobile ? (
        <div className="space-y-3">
          {filtered.map((exec) => (
            <ExecutionListCard
              key={exec.id}
              execution={exec}
              isSelected={false}
              onSelect={() => handleSelectExecution(exec.id)}
            />
          ))}
        </div>
      ) : (
        <div className="mt-4 grid gap-6 lg:grid-cols-[380px_1fr]">
          <div className="space-y-3">
            {filtered.map((exec) => (
              <ExecutionListCard
                key={exec.id}
                execution={exec}
                isSelected={exec.id === selectedExecution?.id}
                onSelect={() => handleSelectExecution(exec.id)}
              />
            ))}
          </div>
          {selectedExecution ? (
            <LiveExecutionDetail execution={selectedExecution} />
          ) : isRouteExecutionMissing ? (
            <EmptyState
              title="Execution not found"
              description="This execution is no longer available or you no longer have access to it."
            />
          ) : null}
        </div>
      )}
    </section>
  )
}

function ExecutionListCard({
  execution,
  isSelected,
  onSelect,
}: {
  execution: ExecutionData
  isSelected: boolean
  onSelect: () => void
}) {
  "use memo"

  const waitingStep = execution.steps.find(
    (step) =>
      step.status === "Correction Required" || step.status === "Waiting",
  )

  return (
    // biome-ignore lint/a11y/useSemanticElements: div needed to allow nested button in ExecutionCardMenu
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          onSelect()
        }
      }}
      className={cn(
        "flex w-full cursor-pointer flex-col gap-3 rounded-2xl border bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md dark:border-slate-800 dark:bg-slate-900/70",
        isSelected
          ? "border-blue-500 dark:border-blue-400 dark:bg-blue-500/10"
          : "border-slate-200",
      )}
    >
      <div className="flex items-center justify-between">
        <h4 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
          {execution.processName}
          {execution.withoutWaiting && <WithoutWaitingBadge />}
        </h4>
        <div className="flex items-center gap-2">
          <ExecutionCardMenu
            executionId={execution.id}
            status={execution.status}
            processPath={execution.processPath}
            canAbandonExecution={execution.canAbandonExecution}
            canRestartExecution={execution.canRestartExecution}
          />
          <span
            className={cn(
              "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold",
              executionStatusTheme[execution.status as ExecutionStatus] ||
                executionStatusTheme.Running,
            )}
          >
            {execution.status}
          </span>
        </div>
      </div>
      <p className="text-sm text-slate-500 dark:text-slate-400">
        {execution.status === "Completed"
          ? "Finished"
          : `Step ${execution.completedSteps} of ${execution.totalSteps}`}
      </p>
      <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
        <span>Started {formatRelativeTime(execution.startedAt)}</span>
        <span>
          {execution.status === "Completed" && execution.finishedAt
            ? `Completed ${formatRelativeTime(execution.finishedAt)}`
            : `Last activity ${formatRelativeTime(execution.updatedAt)}`}
        </span>
      </div>
      {waitingStep && (
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-xs font-semibold",
              waitingStep.status === "Correction Required"
                ? "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200"
                : "bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
            )}
          >
            {waitingStep.status === "Correction Required"
              ? `Correction required: ${waitingStep.name}`
              : waitingStep.name}
          </span>
        </div>
      )}
      <StepParticipants steps={execution.steps} />
    </div>
  )
}

interface ExecutionStep {
  readonly id: string
  readonly name: string
  readonly path: string
  readonly status:
    | "Completed"
    | "Waiting"
    | "Potential"
    | "Failed"
    | "Correction Required"
    | "Not started"
  readonly failureReason?: string | undefined
  readonly notStartedReason?: string | undefined
  readonly role?:
    | {
        readonly id: string
        readonly name: string
      }
    | undefined
  readonly submittedViaEmbeddedForm?: boolean | undefined
  readonly externalSubmitterEmail?: string | undefined
  readonly assignedProviderUserEmail?: string | undefined
  readonly providerUser?:
    | {
        readonly id: string
        readonly firstName: string
        readonly lastName: string
        readonly picture: string
        readonly orgUnit: string
      }
    | undefined
  readonly startedAt?: string | undefined // ISO date string
  readonly completedAt?: string | undefined // ISO date string
}

interface ExecutionData {
  withoutWaiting: boolean
  id: string
  updatedAt: number
  processStateId: string
  processName: string
  processPath: string
  canAbandonExecution: boolean
  canRestartExecution: boolean
  status: ExecutionStatus
  failureReason?: string | undefined
  notStartedReason?: string | undefined
  abandonedReason?: string | undefined
  startedAt: string // ISO date string
  finishedAt: string | undefined // ISO date string
  completedSteps: number
  totalSteps: number
  durationMs: number | undefined
  estimatedCompletionAt: string | undefined // ISO date string
  slaTargetAt: string | undefined // ISO date string
  steps: readonly ExecutionStep[]
}

const SWIPE_CLOSE_MIN_PX = 72
const SWIPE_CLOSE_HORIZONTAL_RATIO = 1.25

/**
 * Format ISO date string to readable date/time
 */
function formatDateTime(isoString: string | undefined): string {
  if (!isoString) return "N/A"
  const date = new Date(isoString)
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

/**
 * Extract unique participants from execution steps
 */
function getParticipants(steps: readonly ExecutionStep[]) {
  const completedWithProviderUser = steps.filter(
    (
      s,
    ): s is typeof s & {
      providerUser: NonNullable<typeof s.providerUser>
    } => s.status === "Completed" && s.providerUser != null,
  )
  const waitingWithRole = steps.filter(
    (s): s is typeof s & { role: NonNullable<typeof s.role> } =>
      (s.status === "Waiting" || s.status === "Correction Required") &&
      s.role != null,
  )

  // Dedupe provider users by id
  const seenProviderUsers = new Set<string>()
  const uniqueProviderUsers = completedWithProviderUser.filter((step) => {
    const key = step.providerUser.id
    if (seenProviderUsers.has(key)) return false
    seenProviderUsers.add(key)
    return true
  })

  return { providerUsers: uniqueProviderUsers, waitingRoles: waitingWithRole }
}

function LiveExecutionDetail({ execution }: { execution: ExecutionData }) {
  "use memo"

  // Find current waiting step for display
  const currentWaitingStep = execution.steps.find(
    (s) => s.status === "Waiting" || s.status === "Correction Required",
  )
  const failedStep = execution.steps.find((s) => s.status === "Failed")
  const { providerUsers, waitingRoles } = getParticipants(execution.steps)

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900/70">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
            {execution.processName}
            {execution.withoutWaiting && <WithoutWaitingBadge />}
          </h3>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Started {formatRelativeTime(execution.startedAt)}.
            {currentWaitingStep?.status === "Correction Required"
              ? ` Correction required on ${currentWaitingStep.name}.`
              : currentWaitingStep?.providerUser
                ? ` Current assignee: ${currentWaitingStep.providerUser.firstName} ${currentWaitingStep.providerUser.lastName}`
                : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "inline-flex items-center rounded-full px-3 py-1 text-sm font-semibold",
              executionStatusTheme[execution.status as ExecutionStatus] ||
                executionStatusTheme.Running,
            )}
          >
            {execution.status}
          </span>
          <ProcessWorkflowLink
            processName={execution.processName}
            processPath={execution.processPath}
          />
        </div>
      </div>

      {/* Progress */}
      {execution.status === "Not started" && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-200">
          <h4 className="text-sm font-semibold">Not started</h4>
          <p className="mt-2 text-sm">{execution.notStartedReason}</p>
        </div>
      )}
      {execution.status === "Failed" &&
        (execution.failureReason || failedStep) && (
          <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-rose-800 dark:border-rose-900/40 dark:bg-rose-950/20 dark:text-rose-200">
            <h4 className="text-sm font-semibold tracking-wide uppercase">
              Failure
            </h4>
            <p className="mt-2 text-sm leading-relaxed">
              {execution.failureReason ??
                failedStep?.failureReason ??
                "A system step failed."}
            </p>
          </div>
        )}

      {execution.status === "Abandoned" && (
        <div className="rounded-2xl border border-slate-300 bg-slate-100 p-4 text-slate-700 dark:border-slate-600 dark:bg-slate-800/40 dark:text-slate-300">
          <h4 className="text-sm font-semibold tracking-wide uppercase">
            Abandoned
          </h4>
          <p className="mt-2 text-sm leading-relaxed">
            {execution.abandonedReason || "This execution was abandoned."}
          </p>
        </div>
      )}

      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-900/60">
        <h4 className="text-sm font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
          Progress
        </h4>
        <div className="mt-4 space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-slate-600 dark:text-slate-300">
              Steps completed
            </span>
            <span className="font-semibold text-slate-900 dark:text-slate-100">
              {execution.completedSteps} / {execution.totalSteps}
            </span>
          </div>
          <div className="h-2 w-full rounded-full bg-slate-200 dark:bg-slate-700">
            <div
              className="h-2 rounded-full bg-blue-500"
              style={{
                width: `${execution.totalSteps > 0 ? (execution.completedSteps / execution.totalSteps) * 100 : 0}%`,
              }}
            />
          </div>
        </div>
      </div>

      {/* Timeline */}
      {execution.steps.length > 0 && (
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-900/60">
          <h4 className="text-sm font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
            Timeline
          </h4>
          <ul className="mt-4 space-y-4">
            {execution.steps.map((step) => {
              const isEmbeddedSubmission =
                step.submittedViaEmbeddedForm === true
              const hasExternalSubmitterEmail =
                step.externalSubmitterEmail != null &&
                step.externalSubmitterEmail.length > 0
              const showExternalSubmissionInfo =
                step.status !== "Correction Required" &&
                (isEmbeddedSubmission || hasExternalSubmitterEmail)

              return (
                <li key={step.id} className="relative pl-8">
                  <span
                    className={cn(
                      "absolute left-0 top-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full border text-xs font-semibold",
                      step.status === "Completed"
                        ? "border-emerald-500 bg-emerald-500 text-white"
                        : step.status === "Failed"
                          ? "border-rose-500 bg-rose-500 text-white"
                          : step.status === "Correction Required"
                            ? "border-amber-500 bg-amber-500 text-white"
                            : step.status === "Waiting"
                              ? "border-blue-500 bg-blue-500 text-white"
                              : "border-slate-300 bg-white text-slate-400 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-500",
                    )}
                  >
                    {step.status === "Completed"
                      ? "\u2713"
                      : step.status === "Failed"
                        ? "!"
                        : step.status === "Correction Required"
                          ? "?"
                          : step.status === "Waiting"
                            ? "\u2022"
                            : ""}
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      {step.name}
                    </p>
                    {/* External submissions can have internal roles but external submitters. */}
                    {showExternalSubmissionInfo ? (
                      <span className="rounded-full bg-cyan-500/10 px-2 py-0.5 text-[11px] font-semibold text-cyan-700 dark:text-cyan-300">
                        External Participant
                      </span>
                    ) : step.assignedProviderUserEmail ? (
                      <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-[11px] font-semibold text-blue-700 dark:text-blue-300">
                        {step.assignedProviderUserEmail}
                      </span>
                    ) : step.role ? (
                      <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-semibold text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
                        {step.role.name}
                      </span>
                    ) : null}
                  </div>
                  {showExternalSubmissionInfo && hasExternalSubmitterEmail ? (
                    <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                      {step.status === "Waiting"
                        ? "Waiting for"
                        : isEmbeddedSubmission
                          ? "Submitted via embedded form by"
                          : "Submitted by"}{" "}
                      {step.externalSubmitterEmail}
                    </p>
                  ) : isEmbeddedSubmission &&
                    step.status !== "Waiting" &&
                    step.status !== "Correction Required" ? (
                    <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                      Submitted via embedded form (no email recorded)
                    </p>
                  ) : !showExternalSubmissionInfo && step.providerUser ? (
                    <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                      {step.status === "Completed"
                        ? "Completed by"
                        : step.status === "Failed"
                          ? "Failed at"
                          : step.status === "Correction Required"
                            ? "Correction assigned to"
                            : "Assigned to"}{" "}
                      {step.providerUser.firstName} {step.providerUser.lastName}
                    </p>
                  ) : step.status === "Correction Required" && step.role ? (
                    <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                      Correction assigned to {step.role.name}
                    </p>
                  ) : null}
                  {step.status === "Failed" && step.failureReason && (
                    <p className="mt-1 text-xs text-rose-700 dark:text-rose-300">
                      {step.failureReason}
                    </p>
                  )}
                  {step.status === "Not started" && (
                    <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                      Not started: {step.notStartedReason}
                    </p>
                  )}
                  {step.status === "Correction Required" &&
                    step.failureReason && (
                      <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                        {step.failureReason}
                      </p>
                    )}
                  <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
                    {step.startedAt && step.status !== "Not started" && (
                      <span>Started {formatRelativeTime(step.startedAt)}</span>
                    )}
                    {step.completedAt && (
                      <span>
                        {step.status === "Not started"
                          ? `Not started ${formatRelativeTime(step.completedAt)}`
                          : step.status === "Failed"
                            ? `Failed ${formatRelativeTime(step.completedAt)}`
                            : `Completed ${formatRelativeTime(step.completedAt)}`}
                      </span>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {/* Participants and State Snapshot cards */}
      <div className="grid gap-4 md:grid-cols-2">
        {/* Participants */}
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-900/60">
          <h4 className="text-sm font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
            Participants
          </h4>
          <div className="mt-3 space-y-2">
            {providerUsers.map((step) => (
              <div
                key={step.id}
                className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
              >
                <span>
                  {step.providerUser.firstName} {step.providerUser.lastName}
                </span>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {step.providerUser.orgUnit}
                </span>
              </div>
            ))}
            {waitingRoles.map((step) => (
              <div
                key={step.id}
                className="flex items-center justify-between rounded-xl border border-dashed border-slate-300 bg-white px-3 py-2 text-sm text-slate-500 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-400"
              >
                <span className="italic">
                  Waiting for{" "}
                  {step.externalSubmitterEmail ??
                    step.assignedProviderUserEmail ??
                    step.role.name}
                </span>
              </div>
            ))}
            {providerUsers.length === 0 && waitingRoles.length === 0 && (
              <p className="text-sm text-slate-500 dark:text-slate-400">
                No participants yet
              </p>
            )}
          </div>
        </div>

        {/* State Snapshot */}
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-900/60">
          <h4 className="text-sm font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
            State snapshot
          </h4>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-sm text-slate-600 dark:text-slate-300">
            <div>
              <dt className="text-xs tracking-wide text-slate-400 uppercase dark:text-slate-500">
                {execution.status === "Abandoned"
                  ? "Abandoned"
                  : execution.status === "Not started"
                    ? "Not started"
                    : execution.finishedAt
                      ? "Completed"
                      : "Estimated completion"}
              </dt>
              <dd>
                {execution.finishedAt
                  ? formatDateTime(execution.finishedAt)
                  : execution.estimatedCompletionAt
                    ? formatDateTime(execution.estimatedCompletionAt)
                    : "N/A"}
              </dd>
            </div>
            <div>
              <dt className="text-xs tracking-wide text-slate-400 uppercase dark:text-slate-500">
                SLA target
              </dt>
              <dd>
                {execution.slaTargetAt
                  ? formatDateTime(execution.slaTargetAt)
                  : "Not set"}
              </dd>
            </div>
          </dl>
        </div>
      </div>
    </div>
  )
}

function MobileExecutionDetail({
  execution,
  onBack,
}: {
  execution: ExecutionData
  onBack: () => void
}) {
  "use memo"

  const touchStartX = useRef<number | null>(null)
  const touchStartY = useRef<number | null>(null)
  const touchCurrentX = useRef<number | null>(null)
  const touchCurrentY = useRef<number | null>(null)

  const resetSwipe = () => {
    touchStartX.current = null
    touchStartY.current = null
    touchCurrentX.current = null
    touchCurrentY.current = null
  }

  return (
    <div
      className="space-y-4"
      onTouchStart={(event) => {
        const touch = event.touches[0]
        if (!touch) return

        touchStartX.current = touch.clientX
        touchStartY.current = touch.clientY
        touchCurrentX.current = touch.clientX
        touchCurrentY.current = touch.clientY
      }}
      onTouchMove={(event) => {
        const touch = event.touches[0]
        if (!touch) return

        touchCurrentX.current = touch.clientX
        touchCurrentY.current = touch.clientY
      }}
      onTouchEnd={() => {
        if (
          touchStartX.current === null ||
          touchStartY.current === null ||
          touchCurrentX.current === null ||
          touchCurrentY.current === null
        ) {
          resetSwipe()
          return
        }

        const deltaX = touchCurrentX.current - touchStartX.current
        const deltaY = Math.abs(touchCurrentY.current - touchStartY.current)

        resetSwipe()

        if (
          deltaX > SWIPE_CLOSE_MIN_PX &&
          deltaX > deltaY * SWIPE_CLOSE_HORIZONTAL_RATIO
        ) {
          onBack()
        }
      }}
      onTouchCancel={resetSwipe}
    >
      <div className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-3 py-2.5 shadow-sm dark:border-slate-800 dark:bg-slate-900/70">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-50"
        >
          <ChevronLeft className="h-4 w-4" />
          Back
        </button>
        <div className="min-w-0">
          <p className="text-[11px] font-semibold tracking-[0.18em] text-slate-400 uppercase dark:text-slate-500">
            Execution detail
          </p>
          <p className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
            {execution.processName}
            {execution.withoutWaiting && <WithoutWaitingBadge />}
          </p>
        </div>
      </div>

      <div className="animate-in slide-in-from-right-4 duration-200">
        <LiveExecutionDetail execution={execution} />
      </div>
    </div>
  )
}

// =============================================================================
// MOCK IMPLEMENTATION (for reference)
// =============================================================================

function MockExecutionsSection() {
  const [tab, setTab] = useState<MockExecutionTabKey>("in-progress")
  const [view, setView] = useState<MockExecutionView>("timeline")
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(
    mockExecutions[0]?.id ?? null,
  )

  const filtered = useMemo(() => {
    const statuses = mockExecutionTabFilters[tab]
    return mockExecutions.filter((exec) => statuses.includes(exec.status))
  }, [tab])

  const selectedExecution = useMemo(() => {
    if (filtered.length === 0) return null
    const selected = filtered.find((exec) => exec.id === selectedExecutionId)
    return selected ?? filtered[0] ?? null
  }, [filtered, selectedExecutionId])

  return (
    <section className="space-y-6">
      <div className="rounded-2xl border-2 border-amber-500 bg-amber-50 p-2 dark:border-amber-400 dark:bg-amber-900/20">
        <h2 className="mb-4 text-lg font-bold text-amber-700 dark:text-amber-300">
          MOCK DATA (for reference)
        </h2>
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
          <div className="flex flex-wrap items-center gap-2">
            <TabPill
              label="In Progress"
              count={
                mockExecutions.filter(
                  (exec) =>
                    exec.status === "Running" || exec.status === "Paused",
                ).length
              }
              active={tab === "in-progress"}
              onClick={() => setTab("in-progress")}
            />
            <TabPill
              label="Completed"
              count={
                mockExecutions.filter((exec) => exec.status === "Completed")
                  .length
              }
              active={tab === "completed"}
              onClick={() => setTab("completed")}
            />
            <TabPill
              label="Failed / Cancelled"
              count={
                mockExecutions.filter((exec) => exec.status === "Failed").length
              }
              active={tab === "failed"}
              onClick={() => setTab("failed")}
            />
            <TabPill
              label="All"
              count={mockExecutions.length}
              active={tab === "all"}
              onClick={() => setTab("all")}
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setView("timeline")}
              className={cn(
                "rounded-full border px-3 py-1.5 text-sm font-medium",
                view === "timeline"
                  ? "border-blue-500 text-blue-600 dark:text-blue-300"
                  : "border-slate-200 text-slate-500 hover:border-slate-300 hover:text-slate-700 dark:border-slate-700 dark:text-slate-400 dark:hover:border-slate-600 dark:hover:text-slate-200",
              )}
            >
              Timeline
            </button>
            <button
              type="button"
              onClick={() => setView("kanban")}
              className={cn(
                "rounded-full border px-3 py-1.5 text-sm font-medium",
                view === "kanban"
                  ? "border-blue-500 text-blue-600 dark:text-blue-300"
                  : "border-slate-200 text-slate-500 hover:border-slate-300 hover:text-slate-700 dark:border-slate-700 dark:text-slate-400 dark:hover:border-slate-600 dark:hover:text-slate-200",
              )}
            >
              Kanban
            </button>
            <button
              type="button"
              className="rounded-full border border-slate-200 px-3 py-1.5 text-sm text-slate-500 hover:border-slate-300 hover:text-slate-700 dark:border-slate-700 dark:text-slate-400 dark:hover:border-slate-600 dark:hover:text-slate-200"
            >
              Export CSV
            </button>
          </div>
        </div>

        {filtered.length === 0 ? (
          <EmptyState
            title="No executions in this view"
            description="Adjust filters or start a process from the catalog to see live executions."
          />
        ) : view === "kanban" ? (
          <div className="mt-4">
            <MockExecutionKanban executions={filtered} />
          </div>
        ) : (
          <div className="mt-4 grid gap-6 lg:grid-cols-[380px_1fr]">
            <div className="space-y-3">
              {filtered.map((exec) => (
                <button
                  key={exec.id}
                  type="button"
                  onClick={() => setSelectedExecutionId(exec.id)}
                  className={cn(
                    "flex w-full flex-col gap-3 rounded-2xl border bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md dark:border-slate-800 dark:bg-slate-900/70",
                    exec.id === selectedExecution?.id
                      ? "border-blue-500 dark:border-blue-400 dark:bg-blue-500/10"
                      : "border-slate-200",
                  )}
                >
                  <div className="flex items-center justify-between">
                    <h4 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                      {exec.processName} {exec.executionId}
                    </h4>
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold",
                        mockExecutionStatusTheme[exec.status],
                      )}
                    >
                      {exec.status}
                    </span>
                  </div>
                  <p className="text-sm text-slate-500 dark:text-slate-400">
                    {exec.progress}
                  </p>
                  <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                    <span>Started {exec.startDate}</span>
                    <span>Last activity {exec.lastActivity}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {exec.participants.map((participant) => (
                      <MockAvatar
                        key={participant.id}
                        name={participant.name}
                        title={participant.role}
                      />
                    ))}
                  </div>
                </button>
              ))}
            </div>
            {selectedExecution && (
              <MockExecutionDetail execution={selectedExecution} />
            )}
          </div>
        )}
      </div>
    </section>
  )
}

function StepParticipants({ steps }: { steps: readonly ExecutionStep[] }) {
  "use memo"

  const firstParticipant = steps.find(
    (step) =>
      isExternalParticipantStep(step) ||
      (step.status === "Completed" && step.providerUser != null) ||
      ((step.status === "Waiting" || step.status === "Correction Required") &&
        step.role != null),
  )

  if (!firstParticipant) {
    return null
  }

  const isExternalParticipant = isExternalParticipantStep(firstParticipant)

  return (
    <div className="flex flex-wrap items-center gap-2">
      {isExternalParticipant ? (
        <ExternalParticipantChip
          email={firstParticipant.externalSubmitterEmail}
        />
      ) : firstParticipant.providerUser ? (
        <CompletedProviderUserChip
          firstName={firstParticipant.providerUser.firstName}
          lastName={firstParticipant.providerUser.lastName}
          orgUnit={firstParticipant.providerUser.orgUnit}
          picture={firstParticipant.providerUser.picture}
        />
      ) : firstParticipant.role ? (
        <PendingRoleChip roleName={firstParticipant.role.name} />
      ) : null}
    </div>
  )
}

function isExternalParticipantStep(step: ExecutionStep) {
  if (step.status === "Correction Required") return false

  return (
    step.submittedViaEmbeddedForm === true ||
    (step.externalSubmitterEmail != null &&
      step.externalSubmitterEmail.length > 0)
  )
}

function ExternalParticipantChip({ email }: { email: string | undefined }) {
  "use memo"

  return (
    <div className="flex items-center gap-2 rounded-full border border-cyan-400/50 bg-cyan-400/10 py-1 pl-2 pr-3 text-xs text-cyan-700 dark:border-cyan-400/30 dark:bg-cyan-400/10 dark:text-cyan-200">
      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-cyan-500 text-[10px] font-bold tracking-wide text-slate-950">
        EXT
      </span>
      <div>
        <p className="font-semibold">External Participant</p>
        <p className="text-[11px] text-cyan-800/80 dark:text-cyan-200/80">
          {email ?? "Embedded form"}
        </p>
      </div>
    </div>
  )
}

function CompletedProviderUserChip({
  firstName,
  lastName,
  orgUnit,
  picture,
}: {
  firstName: string
  lastName: string
  orgUnit: string
  picture?: string
}) {
  "use memo"

  const initials = `${firstName.charAt(0)}${lastName.charAt(0)}`.toUpperCase()
  return (
    <div className="flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 py-1 pl-2 pr-3 text-xs dark:border-slate-700 dark:bg-slate-800/60">
      {picture ? (
        <Image
          src={picture}
          alt={`${firstName} ${lastName}`}
          width={28}
          height={28}
          className="h-7 w-7 rounded-full"
        />
      ) : (
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-600 text-[11px] font-semibold text-white">
          {initials}
        </span>
      )}
      <div>
        <p className="font-semibold text-slate-700 dark:text-slate-200">
          {firstName}
          <br />
          {lastName}
        </p>
        <p className="text-[11px] text-slate-500 dark:text-slate-400">
          {orgUnit}
        </p>
      </div>
    </div>
  )
}

function PendingRoleChip({ roleName }: { roleName: string }) {
  "use memo"

  return (
    <div className="flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 py-1 pl-2 pr-3 text-xs dark:border-slate-700 dark:bg-slate-800/60">
      <span className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-blue-500 text-[11px] font-semibold text-blue-500">
        ?
      </span>
      <div>
        <p className="font-semibold text-slate-700 dark:text-slate-200">
          {roleName}
        </p>
      </div>
    </div>
  )
}

function MockAvatar({ name, title }: { name: string; title: string }) {
  const initials = name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase()
  return (
    <div className="flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-800/60">
      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-blue-600 text-[11px] font-semibold text-white">
        {initials}
      </span>
      <div>
        <p className="font-semibold text-slate-700 dark:text-slate-200">
          {name}
        </p>
        <p className="text-[11px] text-slate-500 dark:text-slate-400">
          {title}
        </p>
      </div>
    </div>
  )
}

function MockExecutionDetail({ execution }: { execution: Execution }) {
  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900/70">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
            {execution.processName} {execution.executionId}
          </h3>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Started {execution.startDate}. Current assignee{" "}
            {execution.currentRole ? `${execution.currentRole}` : "N/A"}.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "inline-flex items-center rounded-full px-3 py-1 text-sm font-semibold",
              mockExecutionStatusTheme[execution.status],
            )}
          >
            {execution.status}
          </span>
          <button
            type="button"
            className="rounded-full border border-slate-200 px-3 py-1.5 text-sm text-slate-500 hover:border-slate-300 hover:text-slate-700 dark:border-slate-700 dark:text-slate-300 dark:hover:border-slate-600 dark:hover:text-slate-200"
          >
            Share
          </button>
          <button
            type="button"
            className="rounded-full bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-blue-500"
          >
            View audit log
          </button>
        </div>
      </div>
      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-900/60">
        <h4 className="text-sm font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
          Timeline
        </h4>
        <ul className="mt-4 space-y-4">
          {execution.steps.map((step) => (
            <li key={step.id} className="relative pl-8">
              <span
                className={cn(
                  "absolute left-0 top-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full border text-xs font-semibold",
                  step.status === "Complete"
                    ? "border-emerald-500 bg-emerald-500 text-white"
                    : step.status === "Current"
                      ? "border-blue-500 bg-blue-500 text-white"
                      : step.status === "Upcoming"
                        ? "border-slate-300 bg-white text-slate-400 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-500"
                        : "border-slate-300 bg-slate-100 text-slate-400",
                )}
              >
                {step.status === "Complete"
                  ? "✓"
                  : step.status === "Current"
                    ? "•"
                    : ""}
              </span>
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {step.name}
                </p>
                <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-semibold text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
                  {step.role}
                </span>
                {step.assignee && (
                  <span className="text-[11px] text-slate-500 dark:text-slate-400">
                    Assigned to {step.assignee}
                  </span>
                )}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
                {step.startedAt && <span>Started {step.startedAt}</span>}
                {step.completedAt && <span>Completed {step.completedAt}</span>}
                {step.notes && (
                  <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-amber-600 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                    {step.notes}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>
      {execution.failureReason && (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700 dark:border-rose-500/40 dark:bg-rose-900/20 dark:text-rose-200">
          <p className="font-semibold">Failure reason</p>
          <p>{execution.failureReason}</p>
        </div>
      )}
      {execution.abandonedReason && (
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-200">
          <p className="font-semibold">Abandoned reason</p>
          <p>{execution.abandonedReason}</p>
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-900/60">
          <h4 className="text-sm font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
            Participants
          </h4>
          <div className="mt-3 space-y-2">
            {execution.participants.map((participant) => (
              <div
                key={participant.id}
                className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
              >
                <span>{participant.name}</span>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {participant.role}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-900/60">
          <h4 className="text-sm font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
            State snapshot
          </h4>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-sm text-slate-600 dark:text-slate-300">
            <div>
              <dt className="text-xs tracking-wide text-slate-400 uppercase dark:text-slate-500">
                Estimated completion
              </dt>
              <dd>In 2 days</dd>
            </div>
            <div>
              <dt className="text-xs tracking-wide text-slate-400 uppercase dark:text-slate-500">
                SLA target
              </dt>
              <dd>Oct 16, 18:00</dd>
            </div>
            <div>
              <dt className="text-xs tracking-wide text-slate-400 uppercase dark:text-slate-500">
                Current form
              </dt>
              <dd>IT account setup</dd>
            </div>
            <div>
              <dt className="text-xs tracking-wide text-slate-400 uppercase dark:text-slate-500">
                Pending approvals
              </dt>
              <dd>1 manager</dd>
            </div>
          </dl>
        </div>
      </div>
    </div>
  )
}

function MockExecutionKanban({ executions }: { executions: Execution[] }) {
  const columns: { title: string; statuses: Execution["status"][] }[] = [
    { title: "Running", statuses: ["Running", "Paused"] },
    { title: "Completed", statuses: ["Completed"] },
    { title: "Failed", statuses: ["Failed"] },
  ]

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {columns.map((column) => (
        <div
          key={column.title}
          className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900/70"
        >
          <div className="flex items-center justify-between">
            <h4 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
              {column.title}
            </h4>
            <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              {
                executions.filter((exec) =>
                  column.statuses.includes(exec.status),
                ).length
              }
            </span>
          </div>
          <div className="mt-3 space-y-3">
            {executions
              .filter((exec) => column.statuses.includes(exec.status))
              .map((exec) => (
                <div
                  key={exec.id}
                  className="rounded-2xl border border-slate-200 bg-slate-50/60 p-3 text-sm text-slate-600 shadow-sm dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-300"
                >
                  <div className="flex items-center justify-between">
                    <p className="font-semibold text-slate-900 dark:text-slate-100">
                      {exec.processName} {exec.executionId}
                    </p>
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold",
                        mockExecutionStatusTheme[exec.status],
                      )}
                    >
                      {exec.status}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {exec.progress}
                  </p>
                  <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
                    <span>{exec.startDate}</span>
                    <span>{exec.lastActivity}</span>
                  </div>
                </div>
              ))}
            {executions.filter((exec) => column.statuses.includes(exec.status))
              .length === 0 && (
              <div className="rounded-xl border border-dashed border-slate-300 p-4 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
                No executions here yet
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

// =============================================================================
// SHARED COMPONENTS
// =============================================================================

export function ExecutionsPageContent({
  initialSelectedExecutionId = null,
  onMobileBack,
}: {
  initialSelectedExecutionId?: string | null
  onMobileBack?: () => void
}) {
  "use memo"

  const { collectionPromise } = useExecutionCollection()
  const { showMocks } = useMocks()
  const isMobile = useIsMobile()
  const showMocksSection = !isMobile || initialSelectedExecutionId === null

  return (
    <div className="flex-1 space-y-8 overflow-y-auto">
      <Suspense fallback={<ExecutionsSkeleton />}>
        <ExecutionsPageInner
          collectionPromise={collectionPromise}
          initialSelectedExecutionId={initialSelectedExecutionId}
          {...(onMobileBack ? { onMobileBack } : {})}
        />
      </Suspense>
      {showMocks && showMocksSection && <MockExecutionsSection />}
    </div>
  )
}

export default function ExecutionsPage() {
  return <ExecutionsPageContent />
}

function EmptyState({
  title,
  description,
}: {
  title: string
  description: string
}) {
  "use memo"

  return (
    <div className="col-span-full flex flex-col items-center justify-center rounded-3xl border border-dashed border-slate-300 bg-white/60 p-12 text-center dark:border-slate-700 dark:bg-slate-900/40">
      <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
        {title}
      </h3>
      <p className="mt-2 max-w-md text-sm text-slate-500 dark:text-slate-400">
        {description}
      </p>
      <Link
        href="/processes"
        className="mt-5 rounded-full bg-blue-600 px-5 py-2 text-sm font-semibold text-white shadow hover:bg-blue-500"
      >
        Browse processes
      </Link>
    </div>
  )
}
