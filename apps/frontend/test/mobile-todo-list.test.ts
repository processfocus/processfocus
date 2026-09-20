import { describe, expect, test } from "vitest"
import { createMobileTodoList } from "../app/(protected)/to-dos/lib/mobile-todo-list"

describe("createMobileTodoList", () => {
  test("orders todos by mobile urgency first", () => {
    const now = Date.now()
    const assignedAt = new Date(now - 1000 * 60 * 60 * 24 * 2).toISOString()
    const list = createMobileTodoList([
      {
        id: "draft",
        processName: "Onboarding",
        stepName: "Complete contract",
        stepPath: "onboarding/contract",
        status: "Draft",
        dueAt: null,
        assignedAt,
        summary: [],
      },
      {
        id: "upcoming",
        processName: "Onboarding",
        stepName: "Book induction",
        stepPath: "onboarding/induction",
        status: "Upcoming",
        dueAt: new Date(now + 1000 * 60 * 60 * 24).toISOString(),
        assignedAt,
        summary: [],
      },
      {
        id: "active",
        processName: "Finance",
        stepName: "Approve budget",
        stepPath: "finance/approve-budget",
        status: "Active",
        dueAt: new Date(now + 1000 * 60 * 60).toISOString(),
        assignedAt,
        summary: [],
      },
      {
        id: "overdue",
        processName: "Finance",
        stepName: "Chase invoice",
        stepPath: "finance/chase-invoice",
        status: "Active",
        dueAt: new Date(now - 1000 * 60 * 60).toISOString(),
        assignedAt,
        summary: [],
      },
    ])

    expect(list.map((item) => item.id)).toEqual([
      "overdue",
      "active",
      "upcoming",
      "draft",
    ])
  })

  test("derives contextual actions and routes", () => {
    const assignedAt = new Date(
      Date.now() - 1000 * 60 * 60 * 24 * 2,
    ).toISOString()
    const list = createMobileTodoList([
      {
        id: "draft-1",
        processName: "  Purchase   Request ",
        stepName: "  Finish\nrequest  ",
        stepPath: "finance/purchase/finish",
        status: "Draft",
        dueAt: null,
        assignedAt,
        summary: [{ label: "Parent", value: "Alex Example" }],
      },
      {
        id: "upcoming-1",
        processName: "Onboarding",
        stepName: "Review welcome pack",
        stepPath: "hr/onboarding/review",
        status: "Upcoming",
        dueAt: null,
        assignedAt,
        summary: [],
      },
    ])

    expect(list[0]).toEqual({
      id: "upcoming-1",
      processName: "Onboarding",
      title: "Review welcome pack",
      cue: "Upcoming",
      assignedAt,
      dueCue: null,
      summary: [],
      actionLabel: "Preview",
      href: "/to-dos/complete/hr/onboarding/review?todoId=upcoming-1",
      status: "Upcoming",
    })
    expect(list[1]).toEqual({
      id: "draft-1",
      processName: "Purchase Request",
      title: "Finish request",
      cue: "Draft",
      assignedAt,
      dueCue: null,
      summary: [{ label: "Parent", value: "Alex Example" }],
      actionLabel: "Continue",
      href: "/to-dos/complete/finance/purchase/finish?todoId=draft-1",
      status: "Draft",
    })
  })

  test("uses due status text as the mobile cue when available", () => {
    const [item] = createMobileTodoList([
      {
        id: "overdue-1",
        processName: "Finance",
        stepName: "Approve purchase request",
        stepPath: "finance/purchase/approve",
        status: "Active",
        dueAt: new Date(Date.now() - 1000 * 60 * 60 * 26).toISOString(),
        assignedAt: new Date(
          Date.now() - 1000 * 60 * 60 * 24 * 2,
        ).toISOString(),
        summary: [],
      },
    ])

    expect(item.status).toBe("Overdue")
    expect(item.cue.startsWith("Overdue by")).toBe(true)
    expect(item.dueCue?.startsWith("Overdue by")).toBe(true)
    expect(item.actionLabel).toBe("Do")
  })

  test("links correction-required todos to email correction", () => {
    const [item] = createMobileTodoList([
      {
        id: "correction-1",
        processName: "Purchase approval",
        stepName: "External review",
        stepPath: "finance/purchase/review",
        status: "Correction Required",
        dueAt: null,
        assignedAt: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
        summary: [],
      },
    ])

    expect(item.status).toBe("Correction Required")
    expect(item.cue).toBe("Correction required")
    expect(item.dueCue).toBeNull()
    expect(item.actionLabel).toBe("Correct email")
    expect(item.href).toBe(
      "/to-dos/correct/finance/purchase/review?todoId=correction-1",
    )
  })

  test("keeps completed todos from linking back to completion", () => {
    const [item] = createMobileTodoList([
      {
        id: "completed-1",
        processName: "Purchase approval",
        stepName: "External review",
        stepPath: "finance/purchase/review",
        status: "Completed",
        dueAt: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
        assignedAt: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
        summary: [],
      },
    ])

    expect(item.status).toBe("Completed")
    expect(item.cue).toBe("Completed")
    expect(item.dueCue).toBeNull()
    expect(item.actionLabel).toBe("Done")
    expect(item.href).toBeNull()
  })

  test("keeps future due status as structured mobile due cue", () => {
    const [item] = createMobileTodoList([
      {
        id: "active-1",
        processName: "Board",
        stepName: "Inform Board at next meeting",
        stepPath: "board/inform-next-meeting",
        status: "Active",
        dueAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 29).toISOString(),
        assignedAt: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(),
        summary: [],
      },
    ])

    expect(item.status).toBe("Active")
    expect(item.cue.startsWith("Due ")).toBe(true)
    expect(item.dueCue?.startsWith("Due ")).toBe(true)
    expect(item.actionLabel).toBe("Do")
  })
})
