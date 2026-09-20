import { describe, expect, test } from "vitest"
import {
  getMobileHomeOpenTaskCount,
  getMobileHomeViewModel,
} from "../lib/mobile-home-view-model"

describe("mobile home view model", () => {
  test("counts only active, overdue, and correction todos as open tasks", () => {
    expect(
      getMobileHomeOpenTaskCount([
        { status: "Active" },
        { status: "Overdue" },
        { status: "Correction Required" },
        { status: "Completed", dueAt: "2026-05-19T12:00:00.000Z" },
        { status: "Draft" },
        { status: "Upcoming" },
      ]),
    ).toBe(3)
  })

  test("returns zero when there are no open tasks", () => {
    expect(
      getMobileHomeOpenTaskCount([{ status: "Draft" }, { status: "Upcoming" }]),
    ).toBe(0)
    expect(getMobileHomeViewModel([]).cards.todos.detail).toBe("0 open tasks")
  })

  test("builds todo card copy from the live open-task count", () => {
    const viewModel = getMobileHomeViewModel([
      { status: "Active" },
      { status: "Overdue" },
    ])

    expect(viewModel.title).toBe("Home")
    expect(viewModel.cards.todos).toEqual({
      title: "My To-Dos",
      href: "/to-dos",
      detail: "2 open tasks",
      supportingText:
        "Active, overdue, and correction tasks that need attention.",
    })
    expect(viewModel.cards.startProcess).toEqual({
      title: "Start process",
      href: "/processes",
      detail: "Launch a new workflow.",
      supportingText: "Browse the processes you can start right now.",
    })
  })

  test("uses singular todo copy for a single open task", () => {
    const viewModel = getMobileHomeViewModel([{ status: "Active" }])

    expect(viewModel.cards.todos.detail).toBe("1 open task")
  })
})
