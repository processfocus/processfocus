import { isPast } from "date-fns"
import type { TodoDocType } from "@/lib/collections/todo"
import { type TaskStatus, todoStatusSortOrder } from "@/lib/todo-types"
import { formatDueStatus } from "@/lib/todo-utils"
import { toUrlPath } from "@/lib/utils"

export interface MobileTodoListItem {
  id: string
  title: string
  processName: string
  summary: TodoDocType["summary"]
  cue: string
  assignedAt: string
  dueCue: string | null
  actionLabel: "Do" | "Correct email" | "Continue" | "Preview" | "Done"
  href: string | null
  status: TaskStatus
}

type MobileTodoSource = Pick<
  TodoDocType,
  | "id"
  | "processName"
  | "stepName"
  | "stepPath"
  | "status"
  | "dueAt"
  | "assignedAt"
  | "summary"
>

const collapseWhitespace = (value: string) => value.replace(/\s+/g, " ").trim()

const normalizeStatus = (status: string): TaskStatus => {
  if (
    status === "Active" ||
    status === "Correction Required" ||
    status === "Upcoming" ||
    status === "Draft" ||
    status === "Completed" ||
    status === "Overdue"
  ) {
    return status
  }

  return "Active"
}

const getEffectiveStatus = (
  status: TaskStatus,
  dueAt: string | null | undefined,
): TaskStatus => {
  if (status === "Active" && dueAt && isPast(new Date(dueAt))) {
    return "Overdue"
  }

  return status
}

const getActionLabel = (
  status: TaskStatus,
): MobileTodoListItem["actionLabel"] => {
  if (status === "Draft") {
    return "Continue"
  }

  if (status === "Correction Required") {
    return "Correct email"
  }

  if (status === "Upcoming") {
    return "Preview"
  }

  if (status === "Completed") {
    return "Done"
  }

  return "Do"
}

const getCue = (
  status: TaskStatus,
  dueAt: string | null | undefined,
): string => {
  if (status === "Correction Required") {
    return "Correction required"
  }

  if (status === "Completed") {
    return "Completed"
  }

  const dueStatus = formatDueStatus(dueAt)
  if (dueStatus) {
    return dueStatus
  }

  return status
}

const getDueTime = (dueAt: string | null | undefined): number => {
  if (!dueAt) {
    return Number.POSITIVE_INFINITY
  }

  const time = new Date(dueAt).getTime()
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time
}

export const createMobileTodoList = (
  todos: ReadonlyArray<MobileTodoSource>,
): MobileTodoListItem[] => {
  return [...todos]
    .map((todo) => ({
      todo,
      status: getEffectiveStatus(normalizeStatus(todo.status), todo.dueAt),
      dueTime: getDueTime(todo.dueAt),
    }))
    .sort((left, right) => {
      const statusDifference =
        todoStatusSortOrder[left.status] - todoStatusSortOrder[right.status]
      if (statusDifference !== 0) {
        return statusDifference
      }

      const dueDifference = left.dueTime - right.dueTime
      if (dueDifference !== 0) {
        return dueDifference
      }

      return left.todo.stepName.localeCompare(right.todo.stepName)
    })
    .map(({ todo, status }) => ({
      id: todo.id,
      title: collapseWhitespace(todo.stepName),
      processName: collapseWhitespace(todo.processName),
      summary: todo.summary ?? [],
      cue: getCue(status, todo.dueAt),
      assignedAt: todo.assignedAt,
      dueCue:
        status === "Correction Required" || status === "Completed"
          ? null
          : formatDueStatus(todo.dueAt),
      actionLabel: getActionLabel(status),
      href:
        status === "Completed"
          ? null
          : status === "Correction Required"
            ? `/to-dos/correct/${toUrlPath(todo.stepPath)}?todoId=${encodeURIComponent(todo.id)}`
            : `/to-dos/complete/${toUrlPath(todo.stepPath)}?todoId=${encodeURIComponent(todo.id)}`,
      status,
    }))
}
