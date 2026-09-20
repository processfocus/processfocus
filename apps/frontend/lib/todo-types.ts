import type { TaskPriority } from "@pf/rxdb-collections"

export type TaskStatus =
  | "Active"
  | "Completed"
  | "Upcoming"
  | "Draft"
  | "Overdue"
  | "Correction Required"

export type PersistedTaskStatus = Extract<
  TaskStatus,
  "Active" | "Completed" | "Correction Required"
>

export const todoStatusSortOrder: Record<TaskStatus, number> = {
  Overdue: 0,
  "Correction Required": 1,
  Active: 2,
  Upcoming: 3,
  Draft: 4,
  Completed: 5,
}

export interface SavedView {
  id: string
  name: string
  statuses: TaskStatus[]
  priorities: TaskPriority[]
}

export const taskSavedViews: SavedView[] = [
  { id: "all", name: "All Tasks", statuses: [], priorities: [] },
  {
    id: "overdue",
    name: "Overdue",
    statuses: ["Overdue"],
    priorities: [],
  },
  {
    id: "urgent",
    name: "Urgent",
    statuses: ["Active", "Overdue"],
    priorities: ["High"],
  },
  {
    id: "corrections",
    name: "Corrections",
    statuses: ["Correction Required"],
    priorities: [],
  },
  {
    id: "drafts",
    name: "Drafts",
    statuses: ["Draft"],
    priorities: [],
  },
  {
    id: "upcoming",
    name: "Upcoming",
    statuses: ["Upcoming"],
    priorities: [],
  },
]
