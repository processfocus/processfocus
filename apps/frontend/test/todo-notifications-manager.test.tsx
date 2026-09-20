import type { Collection } from "@tanstack/db"
import { JSDOM } from "jsdom"
import { act } from "react"
import { type Root, createRoot } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { TodoDocType } from "../lib/collections/todo-collection-provider"

const mocks = {
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND")
  }),
  push: vi.fn(),
  useSearchParams: vi.fn(() => new URLSearchParams()),
  useLiveQuery: vi.fn(),
}

vi.mock("next/navigation", () => ({
  notFound: mocks.notFound,
  useRouter: () => ({
    push: mocks.push,
  }),
  useSearchParams: mocks.useSearchParams,
}))

vi.mock("@tanstack/react-db", () => ({
  useLiveQuery: mocks.useLiveQuery,
}))

vi.mock("@/components/auth-provider", () => ({
  useSession: () => ({ userId: "user-1" }),
}))

vi.mock("@/components/config-provider", () => ({
  useRuntimeConfig: () => ({ orgId: "org-1" }),
}))

vi.mock("@/lib/collections/todo-collection-provider", () => ({
  useTodoCollection: () => ({
    collectionPromise: Promise.resolve({} as Collection<TodoDocType, string>),
  }),
}))

interface MockNotificationInstance {
  close: ReturnType<typeof vi.fn>
  onclick: (() => void) | null
}

describe("TodoNotificationsManager", () => {
  let cleanupDom: (() => void) | undefined
  let container: HTMLDivElement
  let root: Root
  let notifications: MockNotificationInstance[]
  let focusSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    cleanupDom = installDom("https://console.example.com")
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    notifications = []
    mocks.notFound.mockClear()
    mocks.push.mockReset()
    mocks.useSearchParams.mockClear()
    mocks.useLiveQuery.mockReset()

    const notificationConstructor = vi.fn(() => {
      const notification: MockNotificationInstance = {
        close: vi.fn(),
        onclick: null,
      }
      notifications.push(notification)
      return notification
    })
    Object.defineProperty(notificationConstructor, "permission", {
      configurable: true,
      value: "granted",
    })
    window.Notification =
      notificationConstructor as unknown as typeof window.Notification
    global.Notification =
      notificationConstructor as unknown as typeof global.Notification
    window.localStorage.setItem(
      "pf-desktop-notifications:user-1:org-1",
      "enabled",
    )
    focusSpy = vi.spyOn(window, "focus").mockImplementation(() => undefined)
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    focusSpy.mockRestore()
    cleanupDom?.()
  })

  test("focuses the app and navigates when a new todo notification is clicked", async () => {
    const queryState = {
      data: [{ id: "todo-1", stepName: "First", stepPath: "/first" }],
      isReady: true,
    }
    mocks.useLiveQuery.mockImplementation(() => queryState)

    await act(async () => {
      const { TodoNotificationsManager } = await import(
        "../lib/notifications/use-todo-notifications"
      )
      root.render(
        <TodoNotificationsManager>
          <div>Child content</div>
        </TodoNotificationsManager>,
      )
    })

    expect(notifications).toHaveLength(0)

    queryState.data = [
      queryState.data[0],
      { id: "todo-2", stepName: "Second", stepPath: "/step/path" },
    ]

    await act(async () => {
      const { TodoNotificationsManager } = await import(
        "../lib/notifications/use-todo-notifications"
      )
      root.render(
        <TodoNotificationsManager>
          <div>Child content</div>
        </TodoNotificationsManager>,
      )
    })

    expect(notifications).toHaveLength(1)

    notifications[0]?.onclick?.()

    expect(window.focus).toHaveBeenCalled()
    expect(notifications[0]?.close).toHaveBeenCalled()
    expect(mocks.push).toHaveBeenCalledWith(
      "/to-dos/complete/step/path?todoId=todo-2",
    )
  })
})

const installDom = (url: string) => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url })
  const previousWindow = global.window
  const previousDocument = global.document
  const previousNavigator = global.navigator
  const previousNotification = global.Notification
  const previousActEnvironment = global.IS_REACT_ACT_ENVIRONMENT

  global.window = dom.window as unknown as Window & typeof globalThis
  global.document = dom.window.document
  global.navigator = dom.window.navigator
  global.IS_REACT_ACT_ENVIRONMENT = true

  return () => {
    dom.window.close()
    global.window = previousWindow
    global.document = previousDocument
    global.navigator = previousNavigator
    global.Notification = previousNotification
    global.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
  }
}
