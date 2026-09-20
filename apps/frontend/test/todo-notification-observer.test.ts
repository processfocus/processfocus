import { beforeEach, describe, expect, test, vi } from "vitest"
import { createTodoNotificationObserver } from "../lib/notifications/todo-notification-observer"

// Mock the Notification API
const MockNotification = vi.fn()
global.Notification = MockNotification as unknown as typeof global.Notification

describe("todo notification observer", () => {
  const createMockTodo = (id: string, stepName: string, stepPath: string) => ({
    id,
    stepName,
    stepPath,
  })

  beforeEach(() => {
    MockNotification.mockReset()
  })

  test("first update establishes baseline without notifications", () => {
    const onNotificationClick = vi.fn()
    const onNotificationDispatched = vi.fn()

    const observer = createTodoNotificationObserver({
      isEnabled: () => true,
      onNotificationClick,
      onNotificationDispatched,
    })

    const todos = [
      createMockTodo("todo-1", "First Todo", "path/to/first"),
      createMockTodo("todo-2", "Second Todo", "path/to/second"),
    ]

    const result = observer.processUpdate(todos)

    expect(result.baselineEstablished).toBe(true)
    expect(result.notificationsDispatched).toBe(0)
    expect(result.notifiedTodoIds).toEqual([])
    expect(onNotificationDispatched).not.toHaveBeenCalled()
    expect(MockNotification).not.toHaveBeenCalled()
  })

  test("subsequent update dispatches notification for new todo", () => {
    const onNotificationClick = vi.fn()
    const onNotificationDispatched = vi.fn()
    const mockNotificationInstance = {
      onclick: null as (() => void) | null,
      close: vi.fn(),
    }
    MockNotification.mockReturnValue(mockNotificationInstance)

    const observer = createTodoNotificationObserver({
      isEnabled: () => true,
      onNotificationClick,
      onNotificationDispatched,
    })

    // First update - establish baseline
    observer.processUpdate([createMockTodo("todo-1", "First Todo", "path/1")])

    // Second update - add new todo
    const result = observer.processUpdate([
      createMockTodo("todo-1", "First Todo", "path/1"),
      createMockTodo("todo-2", "Second Todo", "path/2"),
    ])

    expect(result.baselineEstablished).toBe(false)
    expect(result.notificationsDispatched).toBe(1)
    expect(result.notifiedTodoIds).toEqual(["todo-2"])
    expect(onNotificationDispatched).toHaveBeenCalledWith("todo-2")
    expect(MockNotification).toHaveBeenCalledWith("New to-do arrived", {
      body: "Second Todo",
      tag: "todo-todo-2",
      requireInteraction: false,
    })
  })

  test("update to existing todo does not trigger notification", () => {
    const onNotificationClick = vi.fn()
    const onNotificationDispatched = vi.fn()

    const observer = createTodoNotificationObserver({
      isEnabled: () => true,
      onNotificationClick,
      onNotificationDispatched,
    })

    // First update - establish baseline
    observer.processUpdate([createMockTodo("todo-1", "First Todo", "path/1")])

    // Second update - modify existing todo (same ID)
    MockNotification.mockClear()
    const result = observer.processUpdate([
      createMockTodo("todo-1", "Updated First Todo", "path/1"),
    ])

    expect(result.notificationsDispatched).toBe(0)
    expect(result.notifiedTodoIds).toEqual([])
    expect(onNotificationDispatched).not.toHaveBeenCalled()
    expect(MockNotification).not.toHaveBeenCalled()
  })

  test("does not dispatch notifications when disabled", () => {
    const onNotificationClick = vi.fn()
    const onNotificationDispatched = vi.fn()

    const observer = createTodoNotificationObserver({
      isEnabled: () => false,
      onNotificationClick,
      onNotificationDispatched,
    })

    // First update - establish baseline
    observer.processUpdate([createMockTodo("todo-1", "First Todo", "path/1")])

    // Second update - add new todo (but notifications disabled)
    MockNotification.mockClear()
    const result = observer.processUpdate([
      createMockTodo("todo-1", "First Todo", "path/1"),
      createMockTodo("todo-2", "Second Todo", "path/2"),
    ])

    expect(result.notificationsDispatched).toBe(0)
    expect(MockNotification).not.toHaveBeenCalled()
  })

  test("notification click handler focuses app and navigates", () => {
    const onNotificationClick = vi.fn()
    const mockNotificationInstance = {
      onclick: null as (() => void) | null,
      close: vi.fn(),
    }
    MockNotification.mockReturnValue(mockNotificationInstance)

    const observer = createTodoNotificationObserver({
      isEnabled: () => true,
      onNotificationClick,
    })

    // Establish baseline and add new todo
    observer.processUpdate([createMockTodo("todo-1", "First Todo", "path/1")])
    observer.processUpdate([
      createMockTodo("todo-2", "Second Todo", "step/path/to/todo"),
    ])

    // Simulate notification click
    expect(mockNotificationInstance.onclick).toBeDefined()
    mockNotificationInstance.onclick?.()

    expect(mockNotificationInstance.close).toHaveBeenCalled()
    expect(onNotificationClick).toHaveBeenCalledWith(
      "todo-2",
      "step/path/to/todo",
    )
  })

  test("multiple new todos in single update dispatch multiple notifications", () => {
    const onNotificationClick = vi.fn()
    const onNotificationDispatched = vi.fn()
    MockNotification.mockReturnValue({
      onclick: null,
      close: vi.fn(),
    })

    const observer = createTodoNotificationObserver({
      isEnabled: () => true,
      onNotificationClick,
      onNotificationDispatched,
    })

    // First update - establish baseline
    observer.processUpdate([createMockTodo("todo-1", "First Todo", "path/1")])

    // Second update - add multiple new todos
    MockNotification.mockClear()
    const result = observer.processUpdate([
      createMockTodo("todo-1", "First Todo", "path/1"),
      createMockTodo("todo-2", "Second Todo", "path/2"),
      createMockTodo("todo-3", "Third Todo", "path/3"),
    ])

    expect(result.notificationsDispatched).toBe(2)
    expect(result.notifiedTodoIds).toEqual(["todo-2", "todo-3"])
    expect(MockNotification).toHaveBeenCalledTimes(2)
  })

  test("does not notify again when a previously seen todo ID reappears", () => {
    const onNotificationClick = vi.fn()
    MockNotification.mockReturnValue({
      onclick: null,
      close: vi.fn(),
    })

    const observer = createTodoNotificationObserver({
      isEnabled: () => true,
      onNotificationClick,
    })

    // First update - establish baseline with two todos
    observer.processUpdate([
      createMockTodo("todo-1", "First Todo", "path/1"),
      createMockTodo("todo-2", "Second Todo", "path/2"),
    ])

    // Second update - todo-2 is deleted
    observer.processUpdate([createMockTodo("todo-1", "First Todo", "path/1")])

    // Third update - todo-2 is "re-created" (or same ID reappears)
    MockNotification.mockClear()
    const result = observer.processUpdate([
      createMockTodo("todo-1", "First Todo", "path/1"),
      createMockTodo("todo-2", "Second Todo", "path/2"),
    ])

    expect(result.notificationsDispatched).toBe(0)
    expect(result.notifiedTodoIds).toEqual([])
  })

  test("uses default body when stepName is empty", () => {
    const onNotificationClick = vi.fn()
    MockNotification.mockReturnValue({
      onclick: null,
      close: vi.fn(),
    })

    const observer = createTodoNotificationObserver({
      isEnabled: () => true,
      onNotificationClick,
    })

    // Establish baseline
    observer.processUpdate([createMockTodo("todo-1", "First Todo", "path/1")])

    // Add new todo with empty stepName
    MockNotification.mockClear()
    observer.processUpdate([
      createMockTodo("todo-1", "First Todo", "path/1"),
      { id: "todo-2", stepName: "", stepPath: "path/2" },
    ])

    expect(MockNotification).toHaveBeenCalledWith("New to-do arrived", {
      body: "A new task requires your attention",
      tag: "todo-todo-2",
      requireInteraction: false,
    })
  })
})
