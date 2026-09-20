"use client"

import type { Collection } from "@tanstack/db"
import { useLiveQuery } from "@tanstack/react-db"
import DOMPurify from "dompurify"
import Link from "next/link"
import {
  type ReactNode,
  Suspense,
  use,
  useEffect,
  useMemo,
  useState,
} from "react"
import type { TaskPriority } from "@pf/rxdb-collections"
import { Button } from "@pf/shadcn-components"
import {
  type MobileTodoListItem,
  createMobileTodoList,
} from "./lib/mobile-todo-list"
import { useMocks } from "@/components/mocks-provider"
import {
  TodoCollectionProvider,
  type TodoDocType,
  useTodoCollection,
} from "@/lib/collections/todo-collection-provider"
import { type Task, tasks } from "@/lib/mock-data"
import {
  type SavedView,
  type TaskStatus,
  taskSavedViews,
  todoStatusSortOrder,
} from "@/lib/todo-types"
import {
  assignedAtRefreshDelay,
  computeTodoStatus,
  formatAssignedAtExact,
  formatAssignedAtLabel,
  formatDueStatus,
  isDueWithin24Hours,
  useOverdueRefresh,
} from "@/lib/todo-utils"
import { toUrlPath } from "@/lib/utils"

// Completed Todos can appear in local data, but this page's filters focus on
// actionable work queues rather than historical completion state.
const statusOptions: TaskStatus[] = [
  "Active",
  "Correction Required",
  "Upcoming",
  "Draft",
  "Overdue",
]

const priorityOptions: TaskPriority[] = ["High", "Medium", "Low"]

const sortOptions = [
  "Due date",
  "Priority",
  "Date created",
  "Alphabetical",
] as const

type TaskSortKey = (typeof sortOptions)[number]

function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ")
}

const statusTheme: Record<TaskStatus, { badge: string; card: string }> = {
  Active: {
    badge:
      "bg-emerald-100 text-emerald-700 border border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/30",
    card: "border-emerald-100 dark:border-emerald-500/20",
  },
  Upcoming: {
    badge:
      "bg-slate-100 text-slate-600 border border-slate-200 dark:bg-slate-700/40 dark:text-slate-300 dark:border-slate-600/60",
    card: "border-dashed border-slate-200 dark:border-slate-700",
  },
  Draft: {
    badge:
      "bg-indigo-100 text-indigo-700 border border-indigo-200 dark:bg-indigo-500/10 dark:text-indigo-300 dark:border-indigo-500/30",
    card: "border-indigo-100 dark:border-indigo-500/20",
  },
  Overdue: {
    badge:
      "bg-rose-100 text-rose-700 border border-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:border-rose-500/30",
    card: "border-rose-200 dark:border-rose-500/30 bg-rose-50/70 dark:bg-rose-900/20",
  },
  "Correction Required": {
    badge:
      "bg-amber-100 text-amber-800 border border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/30",
    card: "border-amber-200 dark:border-amber-500/30 bg-amber-50/70 dark:bg-amber-900/20",
  },
  Completed: {
    badge:
      "bg-slate-100 text-slate-600 border border-slate-200 dark:bg-slate-700/40 dark:text-slate-300 dark:border-slate-600/60",
    card: "border-slate-200 dark:border-slate-700 opacity-80",
  },
}

const priorityTheme: Record<TaskPriority, string> = {
  High: "bg-rose-500",
  Medium: "bg-amber-400",
  Low: "bg-slate-400",
}

const correctionHelp = "Correct the recipient email and send a new invitation."

function ToDosPageContent() {
  const { showMocks } = useMocks()

  return (
    <div className="flex-1 overflow-y-auto">
      {/* Real todos from RxDB collection */}
      <RealTodosSection />

      {/* Mock data section below for reference */}
      {showMocks && <MockTodosSection />}
    </div>
  )
}

export default function ToDosPage() {
  return (
    <TodoCollectionProvider>
      <ToDosPageContent />
    </TodoCollectionProvider>
  )
}

/**
 * @deprecated This component displays mock data for design reference.
 * Will be removed once RealTodosSection is fully styled.
 */
function MockTodosSection() {
  const [density, setDensity] = useState<"comfortable" | "compact">(
    "comfortable",
  )
  const [selectedView, setSelectedView] = useState<SavedView["id"]>(
    taskSavedViews[0]?.id ?? "all",
  )
  const [statusFilter, setStatusFilter] = useState<TaskStatus[]>(
    taskSavedViews[0]?.statuses ?? [],
  )
  const [priorityFilter, setPriorityFilter] = useState<TaskPriority[]>(
    taskSavedViews[0]?.priorities ?? [],
  )
  const [sortKey, setSortKey] = useState<TaskSortKey>("Due date")

  const filteredTasks = useMemo(() => {
    return tasks.filter((task) => {
      const statusMatch =
        statusFilter.length === 0 || statusFilter.includes(task.status)
      const priorityMatch =
        priorityFilter.length === 0 || priorityFilter.includes(task.priority)
      return statusMatch && priorityMatch
    })
  }, [priorityFilter, statusFilter])

  const sortedTasks = useMemo(() => {
    const list = [...filteredTasks]
    if (sortKey === "Priority") {
      const rank: Record<TaskPriority, number> = { High: 0, Medium: 1, Low: 2 }
      list.sort((a, b) => rank[a.priority] - rank[b.priority])
    } else if (sortKey === "Alphabetical") {
      list.sort((a, b) => a.stepName.localeCompare(b.stepName))
    } else if (sortKey === "Due date") {
      list.sort(
        (a, b) => todoStatusSortOrder[a.status] - todoStatusSortOrder[b.status],
      )
    }
    return list
  }, [filteredTasks, sortKey])

  function handleSelectView(viewId: SavedView["id"]) {
    setSelectedView(viewId)
    const view = taskSavedViews.find((item) => item.id === viewId)
    if (view) {
      setStatusFilter(view.statuses)
      setPriorityFilter(view.priorities)
    }
  }

  function toggleStatusFilter(status: TaskStatus) {
    setStatusFilter((previous) =>
      previous.includes(status)
        ? previous.filter((item) => item !== status)
        : [...previous, status],
    )
    setSelectedView("custom")
  }

  function togglePriorityFilter(priority: TaskPriority) {
    setPriorityFilter((previous) =>
      previous.includes(priority)
        ? previous.filter((item) => item !== priority)
        : [...previous, priority],
    )
    setSelectedView("custom")
  }

  function clearStatusOnly() {
    setStatusFilter([])
    setSelectedView("custom")
  }

  function clearPriorityOnly() {
    setPriorityFilter([])
    setSelectedView("custom")
  }

  function clearTaskFilters() {
    clearStatusOnly()
    clearPriorityOnly()
  }

  const overdueCount = tasks.filter((task) => task.status === "Overdue").length
  const draftCount = tasks.filter((task) => task.status === "Draft").length
  const upcomingCount = tasks.filter(
    (task) => task.status === "Upcoming",
  ).length

  return (
    <section className="mt-8 space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <OverviewCard
          title="Active tasks"
          value={tasks
            .filter((task) => task.status === "Active")
            .length.toString()}
          subtext="Due within 24 hours: 2"
          accent="bg-sky-500"
        />
        <OverviewCard
          title="Overdue"
          value={overdueCount.toString()}
          subtext="Escalations triggered today"
          accent="bg-rose-500"
        />
        <OverviewCard
          title="Drafts"
          value={draftCount.toString()}
          subtext="Autosave enabled every 30s"
          accent="bg-indigo-500"
        />
        <OverviewCard
          title="Upcoming"
          value={upcomingCount.toString()}
          subtext="Forecast across next 7 days"
          accent="bg-amber-500"
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
        <div className="flex flex-wrap gap-2">
          {taskSavedViews.map((view) => {
            const isActive = selectedView === view.id
            return (
              <button
                key={view.id}
                type="button"
                onClick={() => handleSelectView(view.id)}
                className={cn(
                  "rounded-full border px-4 py-1.5 text-sm font-medium transition",
                  isActive
                    ? "border-blue-500 bg-blue-500 text-white shadow-sm"
                    : "border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:border-slate-600 dark:hover:bg-slate-800",
                )}
              >
                {view.name}
              </button>
            )
          })}
          {selectedView === "custom" && (
            <span className="rounded-full border border-dashed border-blue-300 px-4 py-1.5 text-sm font-medium text-blue-500">
              Custom view
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setDensity("comfortable")}
            className={cn(
              "rounded-full border px-3 py-1.5 text-sm",
              density === "comfortable"
                ? "border-blue-500 text-blue-600 dark:text-blue-300"
                : "border-slate-200 text-slate-500 hover:border-slate-300 hover:text-slate-700 dark:border-slate-700 dark:text-slate-400 dark:hover:border-slate-600 dark:hover:text-slate-200",
            )}
          >
            Comfortable
          </button>
          <button
            type="button"
            onClick={() => setDensity("compact")}
            className={cn(
              "rounded-full border px-3 py-1.5 text-sm",
              density === "compact"
                ? "border-blue-500 text-blue-600 dark:text-blue-300"
                : "border-slate-200 text-slate-500 hover:border-slate-300 hover:text-slate-700 dark:border-slate-700 dark:text-slate-400 dark:hover:border-slate-600 dark:hover:text-slate-200",
            )}
          >
            Compact
          </button>
        </div>
      </div>
      <div className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
        <div className="flex flex-wrap gap-3">
          <FilterGroup
            label="Status"
            onClear={statusFilter.length > 0 ? clearStatusOnly : undefined}
          >
            {statusOptions.map((status) => (
              <Chip
                key={status}
                label={status}
                active={statusFilter.includes(status)}
                onClick={() => toggleStatusFilter(status)}
              />
            ))}
          </FilterGroup>
          <FilterGroup
            label="Priority"
            onClear={priorityFilter.length > 0 ? clearPriorityOnly : undefined}
          >
            {priorityOptions.map((priority) => (
              <Chip
                key={priority}
                label={priority}
                active={priorityFilter.includes(priority)}
                icon={
                  <span
                    className={cn(
                      "h-2.5 w-2.5 rounded-full",
                      priorityTheme[priority],
                    )}
                  />
                }
                onClick={() => togglePriorityFilter(priority)}
              />
            ))}
          </FilterGroup>
          <div className="ml-auto flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-900">
              <label
                htmlFor="mock-sort-select"
                className="text-xs tracking-wide text-slate-400 uppercase"
              >
                Sort
              </label>
              <select
                id="mock-sort-select"
                value={sortKey}
                onChange={(event) =>
                  setSortKey(event.target.value as TaskSortKey)
                }
                className="bg-transparent text-sm font-medium text-slate-700 outline-none dark:text-slate-200"
              >
                {sortOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </div>
            {(statusFilter.length > 0 || priorityFilter.length > 0) && (
              <button
                type="button"
                onClick={clearTaskFilters}
                className="rounded-full border border-slate-200 px-3 py-1.5 text-sm text-slate-500 hover:border-slate-300 hover:text-slate-700 dark:border-slate-700 dark:text-slate-400 dark:hover:border-slate-600 dark:hover:text-slate-200"
              >
                Clear filters
              </button>
            )}
          </div>
        </div>
        <div
          className={cn(
            "grid gap-4",
            density === "compact"
              ? "md:grid-cols-2 xl:grid-cols-3"
              : "md:grid-cols-2 xl:grid-cols-2",
          )}
        >
          {sortedTasks.length === 0 ? (
            <EmptyState
              title="No tasks match these filters"
              description="Try expanding your filters or check the Processes catalog to kick off new work."
            />
          ) : (
            sortedTasks.map((task) => (
              <MockTodoCard key={task.id} task={task} density={density} />
            ))
          )}
        </div>
      </div>
    </section>
  )
}

function OverviewCard({
  title,
  value,
  subtext,
  accent,
}: {
  title: string
  value: string
  subtext: string
  accent: string
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm transition hover:shadow-md dark:border-slate-800 dark:bg-slate-900/70">
      <div className="flex items-center justify-between px-5 pt-5">
        <p className="text-sm font-semibold text-slate-500 dark:text-slate-400">
          {title}
        </p>
        <span className={cn("h-2 w-12 rounded-full", accent)} />
      </div>
      <div className="px-5 pb-5">
        <p className="text-3xl font-semibold text-slate-900 dark:text-slate-50">
          {value}
        </p>
        <p className="text-sm text-slate-500 dark:text-slate-400">{subtext}</p>
      </div>
    </div>
  )
}

function FilterGroup({
  label,
  children,
  onClear,
}: {
  label: string
  children: ReactNode
  onClear?: (() => void) | undefined
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-500 shadow-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">
      <span className="text-xs tracking-wide text-slate-400 uppercase dark:text-slate-500">
        {label}
      </span>
      {children}
      {onClear && (
        <button
          type="button"
          onClick={onClear}
          className="text-xs font-semibold text-blue-500 hover:text-blue-600"
        >
          Clear
        </button>
      )}
    </div>
  )
}

function Chip({
  label,
  active,
  onClick,
  icon,
}: {
  label: string
  active: boolean
  onClick: () => void
  icon?: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm transition",
        active
          ? "border-blue-500 bg-blue-500/10 text-blue-600 dark:border-blue-400 dark:bg-blue-500/10 dark:text-blue-200"
          : "border-transparent text-slate-600 hover:border-slate-200 hover:bg-slate-100 dark:text-slate-300 dark:hover:border-slate-700 dark:hover:bg-slate-800",
      )}
    >
      {icon}
      {label}
    </button>
  )
}

/**
 * @deprecated This component will be deleted in the near future.
 * Use RealTodoCard instead.
 */
function MockTodoCard({
  task,
  density,
}: {
  task: Task
  density: "comfortable" | "compact"
}) {
  return (
    <article
      className={cn(
        "flex flex-col gap-3 rounded-2xl border bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md dark:bg-slate-900/70",
        statusTheme[task.status].card,
        density === "compact" ? "sm:p-3" : "sm:p-5",
      )}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="inline-flex items-center gap-2">
            <span className="text-xs font-semibold tracking-wide text-slate-400 uppercase dark:text-slate-500">
              {task.processName}
            </span>
            <span
              className={cn(
                "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
                statusTheme[task.status].badge,
              )}
            >
              {task.status}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 px-2 py-0.5 text-xs font-semibold text-slate-500 dark:border-slate-700 dark:text-slate-300">
              <span
                className={cn(
                  "h-2 w-2 rounded-full",
                  priorityTheme[task.priority],
                )}
              />
              {task.priority}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600 dark:bg-slate-700/60 dark:text-slate-300">
              {task.role}
            </span>
          </div>
          <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            {task.stepName}
          </h3>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {task.description}
          </p>
        </div>
        <button
          type="button"
          className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-500 hover:border-slate-300 hover:text-slate-700 dark:border-slate-700 dark:text-slate-400 dark:hover:border-slate-600 dark:hover:text-slate-200"
        >
          View details
        </button>
      </header>
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
        {task.dueDate && (
          <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-1 dark:bg-slate-800">
            ⏰ {task.dueDate}
          </span>
        )}
        {task.upcomingIn && (
          <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-slate-200 px-2 py-1 text-slate-500 dark:border-slate-700 dark:text-slate-300">
            ⏳ {task.upcomingIn}
          </span>
        )}
        {task.overdueBy && (
          <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-1 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
            ⚠️ {task.overdueBy}
          </span>
        )}
        {task.draftSavedAt && (
          <span className="inline-flex items-center gap-1 rounded-full bg-indigo-100 px-2 py-1 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300">
            💾 {task.draftSavedAt}
          </span>
        )}
        <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 px-2 py-1 text-slate-500 dark:border-slate-700 dark:text-slate-300">
          🧭 Assigned {task.assignedDate}
        </span>
        <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 px-2 py-1 text-slate-500 dark:border-slate-700 dark:text-slate-300">
          📝 {task.formComplexity} form
        </span>
      </div>
      <footer className="mt-auto flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button className="min-w-20 rounded-full">
            {task.status === "Draft"
              ? "Continue"
              : task.status === "Upcoming"
                ? "Preview"
                : "Do"}
          </Button>
          <Button variant="outline" className="rounded-full">
            Delegate
          </Button>
        </div>
        <button
          type="button"
          className="text-xs font-semibold text-blue-500 hover:text-blue-600"
        >
          Open form preview →
        </button>
      </footer>
    </article>
  )
}

function EmptyState({
  title,
  description,
  action,
}: {
  title: string
  description: string
  action?: { label: string; href: string }
}) {
  return (
    <div className="col-span-full flex flex-col items-center justify-center rounded-3xl border border-dashed border-slate-300 bg-white/60 p-12 text-center dark:border-slate-700 dark:bg-slate-900/40">
      <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
        {title}
      </h3>
      <p className="mt-2 max-w-md text-sm text-slate-500 dark:text-slate-400">
        {description}
      </p>
      {action && (
        <Link
          href={action.href}
          className="mt-5 rounded-full bg-blue-600 px-5 py-2 text-sm font-semibold text-white shadow hover:bg-blue-500"
        >
          {action.label}
        </Link>
      )}
    </div>
  )
}

// ============================================================================
// Real Todos Section (using RxDB collection)
// ============================================================================

function RealTodosLoadingState() {
  return (
    <section className="space-y-6">
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
        <div className="flex items-center gap-3">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
          <span className="text-sm text-slate-500 dark:text-slate-400">
            Loading todos...
          </span>
        </div>
      </div>
    </section>
  )
}

function RealTodosSectionInner({
  collectionPromise,
}: {
  collectionPromise: Promise<Collection<TodoDocType, string>>
}) {
  "use memo"

  // Suspend until collection is ready
  const todosCollection = use(collectionPromise)

  // Query todos from RxDB collection
  const todosQuery = useLiveQuery((q) =>
    q.from({ todo: todosCollection }).select(({ todo }) => ({
      id: todo.id,
      updatedAt: todo.updatedAt,
      processExecutionId: todo.processExecutionId,
      flowId: todo.flowId,
      processName: todo.processName,
      stepName: todo.stepName,
      stepPath: todo.stepPath,
      role: todo.role,
      description: todo.description,
      status: todo.status,
      priority: todo.priority,
      assignedAt: todo.assignedAt,
      dueAt: todo.dueAt,
      formComplexity: todo.formComplexity,
      summary: todo.summary,
    })),
  )

  const todos = todosQuery.data ?? []

  // Filter state
  const [density, setDensity] = useState<"comfortable" | "compact">(
    "comfortable",
  )
  const [selectedView, setSelectedView] = useState<SavedView["id"]>(
    taskSavedViews[0]?.id ?? "all",
  )
  const [statusFilter, setStatusFilter] = useState<TaskStatus[]>(
    taskSavedViews[0]?.statuses ?? [],
  )
  const [priorityFilter, setPriorityFilter] = useState<TaskPriority[]>(
    taskSavedViews[0]?.priorities ?? [],
  )
  const [sortKey, setSortKey] = useState<TaskSortKey>("Due date")

  // Single pass: compute status counts, due-within-24h count, filter todos, and collect dueTimes
  const counts: Record<TaskStatus, number> = {
    Active: 0,
    Completed: 0,
    "Correction Required": 0,
    Overdue: 0,
    Draft: 0,
    Upcoming: 0,
  }
  let dueWithin24HoursCount = 0
  const filteredTodos: typeof todos = []
  const dueTimes: (string | null | undefined)[] = []

  for (const todo of todos) {
    const status = computeTodoStatus(todo.dueAt, todo.status)
    counts[status]++
    dueTimes.push(todo.dueAt)

    if (status === "Active" && isDueWithin24Hours(todo.dueAt)) {
      dueWithin24HoursCount++
    }

    const statusMatch =
      statusFilter.length === 0 || statusFilter.includes(status)
    const priorityMatch =
      priorityFilter.length === 0 || priorityFilter.includes(todo.priority)

    if (statusMatch && priorityMatch) {
      filteredTodos.push(todo)
    }
  }

  useOverdueRefresh(dueTimes)

  // Sort todos
  const sortedTodos = [...filteredTodos]
  if (sortKey === "Priority") {
    const rank: Record<TaskPriority, number> = { High: 0, Medium: 1, Low: 2 }
    sortedTodos.sort((a, b) => rank[a.priority] - rank[b.priority])
  } else if (sortKey === "Alphabetical") {
    sortedTodos.sort((a, b) => a.stepName.localeCompare(b.stepName))
  } else if (sortKey === "Due date") {
    sortedTodos.sort(
      (a, b) =>
        todoStatusSortOrder[computeTodoStatus(a.dueAt, a.status)] -
        todoStatusSortOrder[computeTodoStatus(b.dueAt, b.status)],
    )
  }

  // Mobile intentionally skips the desktop control bars in this first pass.
  // Known gap: mobile also ignores the desktop saved-view/filter/sort state.
  const mobileTodoList = createMobileTodoList(todos)

  function handleSelectView(viewId: SavedView["id"]) {
    setSelectedView(viewId)
    const view = taskSavedViews.find((item) => item.id === viewId)
    if (view) {
      setStatusFilter(view.statuses)
      setPriorityFilter(view.priorities)
    }
  }

  function toggleStatusFilter(status: TaskStatus) {
    setStatusFilter((previous) =>
      previous.includes(status)
        ? previous.filter((item) => item !== status)
        : [...previous, status],
    )
    setSelectedView("custom")
  }

  function togglePriorityFilter(priority: TaskPriority) {
    setPriorityFilter((previous) =>
      previous.includes(priority)
        ? previous.filter((item) => item !== priority)
        : [...previous, priority],
    )
    setSelectedView("custom")
  }

  function clearStatusOnly() {
    setStatusFilter([])
    setSelectedView("custom")
  }

  function clearPriorityOnly() {
    setPriorityFilter([])
    setSelectedView("custom")
  }

  function clearAllFilters() {
    clearStatusOnly()
    clearPriorityOnly()
  }

  if (!todosQuery.isReady) {
    return <RealTodosLoadingState />
  }

  const {
    Active: activeCount,
    "Correction Required": correctionRequiredCount,
    Overdue: overdueCount,
    Draft: draftCount,
    Upcoming: upcomingCount,
  } = counts

  return (
    <section className="space-y-6">
      {/* Overview cards */}
      <div className="hidden gap-4 md:grid md:grid-cols-2 xl:grid-cols-5">
        <OverviewCard
          title="Active tasks"
          value={activeCount.toString()}
          subtext={`Due within 24 hours: ${dueWithin24HoursCount}`}
          accent="bg-sky-500"
        />
        <OverviewCard
          title="Corrections"
          value={correctionRequiredCount.toString()}
          subtext="Recipient update needed"
          accent="bg-amber-500"
        />
        <OverviewCard
          title="Overdue"
          value={overdueCount.toString()}
          subtext="Requires attention"
          accent="bg-rose-500"
        />
        <OverviewCard
          title="Drafts"
          value={draftCount.toString()}
          subtext="In progress"
          accent="bg-indigo-500"
        />
        <OverviewCard
          title="Upcoming"
          value={upcomingCount.toString()}
          subtext="Scheduled tasks"
          accent="bg-amber-500"
        />
      </div>

      {/* Filter bar with saved views and density toggle */}
      <div className="hidden flex-wrap items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900/60 md:flex">
        <div className="flex flex-wrap gap-2">
          {taskSavedViews.map((view) => {
            const isActive = selectedView === view.id
            return (
              <button
                key={view.id}
                type="button"
                onClick={() => handleSelectView(view.id)}
                className={cn(
                  "rounded-full border px-4 py-1.5 text-sm font-medium transition",
                  isActive
                    ? "border-blue-500 bg-blue-500 text-white shadow-sm"
                    : "border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:border-slate-600 dark:hover:bg-slate-800",
                )}
              >
                {view.name}
              </button>
            )
          })}
          {selectedView === "custom" && (
            <span className="rounded-full border border-dashed border-blue-300 px-4 py-1.5 text-sm font-medium text-blue-500">
              Custom view
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setDensity("comfortable")}
            className={cn(
              "rounded-full border px-3 py-1.5 text-sm",
              density === "comfortable"
                ? "border-blue-500 text-blue-600 dark:text-blue-300"
                : "border-slate-200 text-slate-500 hover:border-slate-300 hover:text-slate-700 dark:border-slate-700 dark:text-slate-400 dark:hover:border-slate-600 dark:hover:text-slate-200",
            )}
          >
            Comfortable
          </button>
          <button
            type="button"
            onClick={() => setDensity("compact")}
            className={cn(
              "rounded-full border px-3 py-1.5 text-sm",
              density === "compact"
                ? "border-blue-500 text-blue-600 dark:text-blue-300"
                : "border-slate-200 text-slate-500 hover:border-slate-300 hover:text-slate-700 dark:border-slate-700 dark:text-slate-400 dark:hover:border-slate-600 dark:hover:text-slate-200",
            )}
          >
            Compact
          </button>
        </div>
      </div>

      <div className="space-y-4 md:hidden">
        {mobileTodoList.length === 0 ? (
          <EmptyState
            title="No to-dos yet"
            description="Check back here when new work reaches your queue."
            action={{ label: "Browse processes", href: "/processes" }}
          />
        ) : (
          mobileTodoList.map((todo) => (
            <MobileTodoRow key={todo.id} todo={todo} />
          ))
        )}
      </div>

      {/* Filter row and todo cards */}
      <div className="hidden flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900/60 md:flex">
        <div className="flex flex-wrap gap-3">
          <FilterGroup
            label="Status"
            onClear={statusFilter.length > 0 ? clearStatusOnly : undefined}
          >
            {statusOptions.map((status) => (
              <Chip
                key={status}
                label={status}
                active={statusFilter.includes(status)}
                onClick={() => toggleStatusFilter(status)}
              />
            ))}
          </FilterGroup>
          <FilterGroup
            label="Priority"
            onClear={priorityFilter.length > 0 ? clearPriorityOnly : undefined}
          >
            {priorityOptions.map((priority) => (
              <Chip
                key={priority}
                label={priority}
                active={priorityFilter.includes(priority)}
                icon={
                  <span
                    className={cn(
                      "h-2.5 w-2.5 rounded-full",
                      priorityTheme[priority],
                    )}
                  />
                }
                onClick={() => togglePriorityFilter(priority)}
              />
            ))}
          </FilterGroup>
          <div className="ml-auto flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-900">
              <label
                htmlFor="real-sort-select"
                className="text-xs tracking-wide text-slate-400 uppercase"
              >
                Sort
              </label>
              <select
                id="real-sort-select"
                value={sortKey}
                onChange={(event) =>
                  setSortKey(event.target.value as TaskSortKey)
                }
                className="bg-transparent text-sm font-medium text-slate-700 outline-none dark:text-slate-200"
              >
                {sortOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </div>
            {(statusFilter.length > 0 || priorityFilter.length > 0) && (
              <button
                type="button"
                onClick={clearAllFilters}
                className="rounded-full border border-slate-200 px-3 py-1.5 text-sm text-slate-500 hover:border-slate-300 hover:text-slate-700 dark:border-slate-700 dark:text-slate-400 dark:hover:border-slate-600 dark:hover:text-slate-200"
              >
                Clear filters
              </button>
            )}
          </div>
        </div>

        {/* Todo cards grid */}
        <div
          className={cn(
            "grid gap-4",
            density === "compact"
              ? "md:grid-cols-2 xl:grid-cols-3"
              : "md:grid-cols-2 xl:grid-cols-2",
          )}
        >
          {sortedTodos.length === 0 ? (
            <EmptyState
              title="No todos match these filters"
              description="Try expanding your filters or check the Processes catalog to kick off new work."
            />
          ) : (
            sortedTodos.map((todo) => (
              <TodoCard key={todo.id} todo={todo} density={density} />
            ))
          )}
        </div>
      </div>
    </section>
  )
}

function RealTodosSection() {
  const { collectionPromise } = useTodoCollection()

  return (
    <Suspense fallback={<RealTodosLoadingState />}>
      <RealTodosSectionInner collectionPromise={collectionPromise} />
    </Suspense>
  )
}

function useAssignedAtToggle(assignedAt: string) {
  const [showExact, setShowExact] = useState(false)
  // Increment only to re-render when the relative assigned label crosses a boundary.
  const [, refreshAssignedAtLabel] = useState(0)
  const exactLabel = formatAssignedAtExact(assignedAt)
  const label = showExact ? exactLabel : formatAssignedAtLabel(assignedAt)

  useEffect(() => {
    let timeoutId: number | undefined
    const scheduleRefresh = () => {
      const delay = assignedAtRefreshDelay(assignedAt)
      if (delay === null) return

      timeoutId = window.setTimeout(() => {
        refreshAssignedAtLabel((tick) => tick + 1)
        scheduleRefresh()
      }, delay)
    }

    scheduleRefresh()
    return () => {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId)
    }
  }, [assignedAt])

  return {
    exactLabel,
    label,
    showExact,
    toggle: () => setShowExact((show) => !show),
  }
}

function MobileTodoRow({ todo }: { todo: MobileTodoListItem }) {
  const assignedAt = useAssignedAtToggle(todo.assignedAt)

  return (
    <article
      className={cn(
        "relative overflow-hidden rounded-2xl border bg-white p-4 shadow-sm dark:bg-slate-900/70",
        statusTheme[todo.status]?.card ??
          "border-slate-200 dark:border-slate-700",
      )}
    >
      {todo.href && (
        <Link
          href={todo.href}
          prefetch={false}
          aria-hidden="true"
          tabIndex={-1}
          data-testid={`mobile-todo-row-link-${todo.id}`}
          className="absolute inset-0 rounded-2xl"
        />
      )}
      <div className="relative z-10 space-y-3">
        <div className="space-y-1">
          <p className="text-xs font-semibold tracking-wide text-slate-400 uppercase dark:text-slate-500">
            {todo.processName}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="inline-flex items-center rounded-full border border-slate-200 px-2 py-0.5 text-xs font-semibold text-slate-500 transition hover:border-slate-300 hover:text-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 dark:border-slate-700 dark:text-slate-300 dark:hover:border-slate-600 dark:hover:text-slate-100"
              title={assignedAt.exactLabel}
              aria-pressed={assignedAt.showExact}
              onClick={assignedAt.toggle}
            >
              {assignedAt.label}
            </button>
            {todo.dueCue && (
              <span
                className={cn(
                  "inline-flex w-fit items-center rounded-full px-2 py-0.5 text-xs font-medium",
                  todo.status === "Overdue"
                    ? "bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300"
                    : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
                )}
              >
                {todo.dueCue}
              </span>
            )}
          </div>
          <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            {todo.title}
          </h3>
          {!todo.dueCue && (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {todo.cue}
            </p>
          )}
        </div>
        {todo.summary.length > 0 && (
          <div className="flex flex-wrap gap-x-3 gap-y-1 border-t border-slate-100 pt-3 text-sm dark:border-slate-800">
            {todo.summary.map((item) => (
              <div
                key={`${item.label}-${item.value}`}
                className="flex min-w-0 max-w-full flex-wrap items-center gap-x-1.5"
              >
                <span className="shrink-0 text-slate-400">{item.label}:</span>
                <span
                  className="min-w-0 break-words text-slate-700 dark:text-slate-300"
                  // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized with DOMPurify
                  dangerouslySetInnerHTML={{
                    __html: DOMPurify.sanitize(item.value),
                  }}
                />
              </div>
            ))}
          </div>
        )}
        <div className="flex justify-end">
          {todo.href ? (
            <Link
              href={todo.href}
              prefetch={false}
              aria-label={`${todo.actionLabel} ${todo.title}`}
              className="rounded-full bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-blue-500"
            >
              {todo.actionLabel}
            </Link>
          ) : (
            <div className="flex flex-col items-end gap-1">
              <button
                type="button"
                disabled
                className="rounded-full bg-slate-200 px-4 py-2 text-sm font-semibold text-slate-500 dark:bg-slate-800 dark:text-slate-400"
              >
                {todo.actionLabel}
              </button>
              {todo.status === "Correction Required" && (
                <p className="max-w-48 text-right text-xs text-amber-700 dark:text-amber-300">
                  {correctionHelp}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </article>
  )
}

function TodoCard({
  todo,
  density = "comfortable",
}: {
  todo: TodoDocType
  density?: "comfortable" | "compact"
}) {
  const effectiveStatus = computeTodoStatus(todo.dueAt, todo.status)
  const priority = todo.priority
  const dueStatusText = formatDueStatus(todo.dueAt)
  // Active is implicit, and Overdue is conveyed by the due badge.
  const showStatusBadge =
    effectiveStatus !== "Active" && effectiveStatus !== "Overdue"
  const assignedAt = useAssignedAtToggle(todo.assignedAt)
  const correctionHelpId = `${todo.id}-correction-pending-help`

  return (
    <article
      className={cn(
        "flex flex-col gap-1 rounded-2xl border bg-white shadow-sm transition hover:-translate-y-0.5 hover:shadow-md dark:bg-slate-900/70",
        statusTheme[effectiveStatus]?.card ??
          "border-slate-200 dark:border-slate-700",
        density === "compact" ? "p-3 sm:p-3" : "p-5 sm:p-5",
      )}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="space-y-2">
          <p className="text-xs font-semibold tracking-wide text-slate-400 uppercase dark:text-slate-500">
            {todo.processName}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 px-2 py-0.5 text-xs font-semibold text-slate-500 dark:border-slate-700 dark:text-slate-300">
              <span
                className={cn(
                  "h-2 w-2 rounded-full",
                  priorityTheme[priority] ?? "bg-slate-400",
                )}
              />
              {todo.priority}
            </span>
            <button
              type="button"
              className="inline-flex items-center rounded-full border border-slate-200 px-2 py-0.5 text-xs font-semibold text-slate-500 transition hover:border-slate-300 hover:text-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 dark:border-slate-700 dark:text-slate-300 dark:hover:border-slate-600 dark:hover:text-slate-100"
              title={assignedAt.exactLabel}
              aria-pressed={assignedAt.showExact}
              onClick={assignedAt.toggle}
            >
              {assignedAt.label}
            </button>
            {dueStatusText && (
              <span
                className={cn(
                  "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
                  effectiveStatus === "Overdue"
                    ? "bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300"
                    : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
                )}
              >
                {dueStatusText}
              </span>
            )}
            {showStatusBadge && (
              <span
                className={cn(
                  "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
                  statusTheme[effectiveStatus]?.badge ??
                    "bg-slate-100 text-slate-600",
                )}
              >
                {effectiveStatus}
              </span>
            )}
          </div>
          <div className="space-y-1">
            <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
              {todo.stepName}
            </h3>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {todo.description}
            </p>
          </div>
        </div>
        <span className="shrink-0 rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600 dark:bg-slate-700/60 dark:text-slate-300">
          {todo.role}
        </span>
      </header>

      {todo.summary && todo.summary.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-slate-100 pt-2 text-sm dark:border-slate-800">
          {todo.summary.map((item) => (
            <div
              key={`${item.label}-${item.value}`}
              className="flex items-center gap-1.5"
            >
              <span className="text-slate-400">{item.label}:</span>
              <span
                className="text-slate-700 dark:text-slate-300"
                // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized with DOMPurify
                dangerouslySetInnerHTML={{
                  __html: DOMPurify.sanitize(item.value),
                }}
              />
            </div>
          ))}
        </div>
      )}

      <footer className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-4">
        <div className="flex items-center gap-2">
          {effectiveStatus === "Completed" ? (
            <Button className="min-w-20 rounded-full" disabled>
              Done
            </Button>
          ) : effectiveStatus === "Correction Required" ? (
            <Button
              asChild
              className="min-w-20 rounded-full"
              aria-describedby={correctionHelpId}
            >
              <Link
                href={`/to-dos/correct/${toUrlPath(todo.stepPath)}?todoId=${encodeURIComponent(todo.id)}`}
                prefetch={false}
              >
                Correct email
              </Link>
            </Button>
          ) : (
            <Button asChild className="min-w-20 rounded-full">
              <Link
                href={`/to-dos/complete/${toUrlPath(todo.stepPath)}?todoId=${encodeURIComponent(todo.id)}`}
                prefetch={false}
              >
                {effectiveStatus === "Draft"
                  ? "Continue"
                  : effectiveStatus === "Upcoming"
                    ? "Preview"
                    : "Do"}
              </Link>
            </Button>
          )}
          <Button variant="outline" className="rounded-full" disabled>
            Delegate
          </Button>
        </div>
        {effectiveStatus === "Correction Required" && (
          <p
            id={correctionHelpId}
            className="basis-full text-xs text-amber-700 dark:text-amber-300"
          >
            {correctionHelp}
          </p>
        )}
        <button
          type="button"
          className="text-xs font-semibold text-blue-500 hover:text-blue-600"
        >
          Open form preview
        </button>
      </footer>
    </article>
  )
}
