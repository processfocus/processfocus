import { computeTodoStatus } from "./todo-utils"
import type { TodoDocType } from "@/lib/collections/todo-collection-provider"

// Mobile home also accepts derived view statuses used by saved views and tests,
// not just the persisted RxDB Todo status literals.
type MobileHomeStatus = TodoDocType["status"] | "Overdue" | "Draft" | "Upcoming"

type MobileHomeTodo = Pick<TodoDocType, "dueAt"> & {
  readonly status?: MobileHomeStatus | null
}

interface MobileHomeCardViewModel {
  title: string
  href: string
  detail: string
  supportingText: string
}

export interface MobileHomeViewModel {
  title: string
  cards: {
    todos: MobileHomeCardViewModel
    startProcess: MobileHomeCardViewModel
  }
}

export function getMobileHomeOpenTaskCount(
  todos: readonly MobileHomeTodo[],
): number {
  return todos.filter((todo) => {
    if (
      todo.status === "Completed" ||
      todo.status === "Draft" ||
      todo.status === "Upcoming"
    ) {
      return false
    }

    const storedStatus = todo.status === "Overdue" ? "Active" : todo.status
    const status = computeTodoStatus(todo.dueAt, storedStatus)
    return (
      status === "Active" ||
      status === "Overdue" ||
      status === "Correction Required"
    )
  }).length
}

export function getMobileHomeViewModel(
  todos: readonly MobileHomeTodo[],
): MobileHomeViewModel {
  const openTaskCount = getMobileHomeOpenTaskCount(todos)
  const openTaskLabel =
    openTaskCount === 1 ? "1 open task" : `${openTaskCount} open tasks`

  return {
    title: "Home",
    cards: {
      todos: {
        title: "My To-Dos",
        href: "/to-dos",
        detail: openTaskLabel,
        supportingText:
          "Active, overdue, and correction tasks that need attention.",
      },
      startProcess: {
        title: "Start process",
        href: "/processes",
        detail: "Launch a new workflow.",
        supportingText: "Browse the processes you can start right now.",
      },
    },
  }
}
