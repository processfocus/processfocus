import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { JSDOM } from "jsdom"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, mock, test } from "bun:test"

mock.module("next/navigation", () => ({ useRouter: () => ({ push() {} }) }))
const graphqlClient = {}
mock.module("@/lib/graphql/client-provider", () => ({
  useGraphqlClient: () => graphqlClient,
}))
let failing: "user" | "roles" | undefined
let taskAssignmentEmailAvailable = true
let submittedTaskAssignmentEmail: boolean | undefined
mock.module("@/lib/graphql/user-queries", () => ({
  fetchUserDetail: async () => {
    if (failing === "user") throw new Error("User refresh failed")
    return {
      provider: "google",
      taskAssignmentEmailAvailable,
      providerUser: {
        id: "provider-one",
        email: "one@example.com",
        name: "One",
        firstName: "One",
        lastName: "",
        roleIds: [],
        notificationPreferences: {
          notifications: {
            todoAssignment: { email: !taskAssignmentEmailAvailable },
            executionFailure: { email: false },
          },
        },
      },
    }
  },
  fetchAllRoles: async () => {
    if (failing === "roles") throw new Error("Roles refresh failed")
    return [{ id: "alpha", name: "Alpha", path: "/Alpha" }]
  },
  saveProviderUser: async (
    ...args: Parameters<
      typeof import("@/lib/graphql/user-queries").saveProviderUser
    >
  ) => {
    submittedTaskAssignmentEmail = args[4]
    return {
      providerUser: {
        __typename: "UpdateProviderUserFailure",
        error: "Role rejected",
      },
      notificationPreferences: {
        __typename: "UpdateNotificationPreferencesSuccess",
      },
    }
  },
}))

const editorScenarios = [
  ["user query failures preserve active edits through recovery", "user"],
  ["role query failures preserve active edits through recovery", "roles"],
  ["unavailable task-assignment email is not editable or submitted", undefined],
] as const

test.each(editorScenarios)(
  "Provider User editor: %s",
  async (_description, target) => {
    const dom = new JSDOM("<div id='root'></div>", {
      url: "http://localhost/settings/users/one",
      pretendToBeVisual: true,
    })
    dom.window.HTMLElement.prototype.scrollIntoView = () => {}
    const globals = {
      window: dom.window,
      document: dom.window.document,
      HTMLElement: dom.window.HTMLElement,
      HTMLInputElement: dom.window.HTMLInputElement,
      Node: dom.window.Node,
      requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
      cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
      IS_REACT_ACT_ENVIRONMENT: true,
    }
    const previous = Object.keys(globals).map(
      (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
    )
    Object.assign(globalThis, globals)
    const { UserEditClient } = await import(
      "../app/(protected)/settings/users/[userId]/client"
    )
    const container = document.getElementById("root")!
    const root = createRoot(container)
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    })
    const settle = async (text: string) => {
      for (let i = 0; i < 100 && !container.textContent?.includes(text); i++) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 5))
        })
      }
      expect(container.textContent).toContain(text)
    }
    const checked = (name: string) =>
      container.querySelector<HTMLInputElement>(`input[name="${name}"]`)
    const refetch = async () => {
      await act(async () => {
        await client.refetchQueries({
          queryKey: target === "user" ? ["userDetail", "one"] : ["allRoles"],
        })
        await new Promise((resolve) => setTimeout(resolve, 10))
      })
    }
    failing = target
    taskAssignmentEmailAvailable = target !== undefined
    submittedTaskAssignmentEmail = true
    try {
      await act(async () =>
        root.render(
          <QueryClientProvider client={client}>
            <UserEditClient userId="one" />
          </QueryClientProvider>,
        ),
      )
      if (target !== undefined) {
        await settle("refresh failed")
        expect(container.querySelector("form")).toBeNull()
        failing = undefined
        await refetch()
      }
      await settle("Edit User")
      if (target === undefined) {
        expect(checked("taskAssignmentEmail")).toBeNull()
        expect(container.textContent).toContain(
          "Task Assignment Emails are unavailable because email delivery is not configured.",
        )
      }
      await act(async () => {
        checked("roleIds")?.click()
        checked("taskAssignmentEmail")?.click()
        checked("executionFailureEmail")?.click()
      })
      await act(async () =>
        container
          .querySelector("form")
          ?.dispatchEvent(
            new dom.window.Event("submit", { bubbles: true, cancelable: true }),
          ),
      )
      await settle("Role rejected")
      if (target === undefined) {
        expect(submittedTaskAssignmentEmail).toBeUndefined()
        expect(checked("executionFailureEmail")?.checked).toBe(true)
        return
      }
      failing = target
      await refetch()
      await settle("refresh failed")
      expect(checked("roleIds")?.checked).toBe(true)
      expect(checked("taskAssignmentEmail")?.checked).toBe(true)
      expect(checked("executionFailureEmail")?.checked).toBe(true)
      expect(container.textContent).toContain("Role rejected")
      failing = undefined
      await refetch()
      expect(container.textContent).not.toContain("refresh failed")
      expect(checked("roleIds")?.checked).toBe(true)
      expect(checked("taskAssignmentEmail")?.checked).toBe(true)
      expect(checked("executionFailureEmail")?.checked).toBe(true)
      expect(container.textContent).toContain("Role rejected")
    } finally {
      await act(async () => root.unmount())
      client.clear()
      dom.window.close()
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else Reflect.deleteProperty(globalThis, key)
      }
    }
  },
)
