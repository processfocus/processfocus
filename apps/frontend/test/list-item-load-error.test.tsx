import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Schema } from "effect"
import { ClientError } from "graphql-request"
import { JSDOM } from "jsdom"
import { type ReactNode, act } from "react"
import { createRoot } from "react-dom/client"
import { expect, mock, test } from "bun:test"

const params = new URLSearchParams()
mock.module("next/navigation", () => ({
  useSearchParams: () => params,
  useRouter: () => ({ back() {} }),
}))
mock.module("@/components/auth-provider", () => ({
  useSession: () => ({ userId: "operator", roles: [] }),
}))
mock.module("@/app/(protected)/lists/lib/list-refresh-provider", () => ({
  useListRefresh: () => ({ invalidate() {} }),
}))
mock.module("@/components/form-dialog-content", () => ({
  FormDialogContent: ({
    children,
    title,
  }: {
    children: ReactNode
    title: string
  }) => <section aria-label={title}>{children}</section>,
}))
mock.module("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => (
    <div role="dialog">{children}</div>
  ),
}))
mock.module("../app/(protected)/lists/components/list-item-edit-form", () => ({
  ListItemEditForm: () => <p>Loaded item form</p>,
}))

let failing = ""
let recovery: Promise<void> = Promise.resolve()
const failure = new ClientError(
  { status: 200, errors: [{ message: "Detail service unavailable" }] },
  { query: "PRIVATE REQUEST DUMP" },
)
const list = {
  path: "/things",
  name: "Things",
  itemQueryName: "thing",
  outputColumns: [],
}
mock.module("@/lib/graphql/list-queries", () => ({
  fetchAvailableLists: async () => {
    if (failing === "lists") throw failure
    await recovery
    return [list]
  },
  fetchListFormMetadata: async () => {
    if (failing === "metadata") throw failure
    await recovery
    return { defaultValues: null }
  },
}))
const loadForm = async () => {
  if (failing === "schema") throw failure
  await recovery
  return Schema.Struct({ id: Schema.String })
}
mock.module("@/lib/organisation-form-loaders", () => ({
  organisationFormLoaders: { "/full/edit": loadForm, "/modal/edit": loadForm },
}))
mock.module("@/lib/graphql/client-provider", () => ({
  useGraphqlClient: () => ({
    request: async () => {
      if (failing === "item") throw failure
      await recovery
      return { thing: { id: "one" } }
    },
  }),
}))

const { default: FullPage } = await import(
  "../app/(protected)/lists/item/[id]/client"
)
const { default: Modal } = await import(
  "../app/(protected)/lists/@modal/(.)item/[id]/client"
)

test.each([FullPage, Modal])(
  "detail view reports and recovers from each loading boundary",
  async (View) => {
    list.path = View === FullPage ? "/full" : "/modal"
    for (const stage of ["schema", "lists", "metadata", "item"]) {
      const dom = new JSDOM("<div id='root'></div>", {
        url: "http://localhost/lists/item/one",
      })
      const original = {
        window: globalThis.window,
        document: globalThis.document,
      }
      Object.assign(globalThis, {
        window: dom.window,
        document: dom.window.document,
        IS_REACT_ACT_ENVIRONMENT: true,
      })
      const container = document.getElementById("root")!
      const root = createRoot(container)
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      })
      failing = stage
      recovery = Promise.resolve()
      const settle = async (text: string) => {
        for (
          let i = 0;
          i < 100 && !container.textContent?.includes(text);
          i++
        ) {
          await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 5))
          })
        }
        expect(container.textContent).toContain(text)
      }
      try {
        await act(async () => {
          root.render(
            <QueryClientProvider client={client}>
              <View listPath={list.path} itemId="one" />
            </QueryClientProvider>,
          )
        })
        await settle("Unable to load this item.")
        expect(container.querySelector('[role="alert"]')).not.toBeNull()
        expect(container.textContent).toContain("Detail service unavailable")
        expect(container.textContent).not.toContain("PRIVATE REQUEST DUMP")
        expect(container.textContent).not.toContain("List Not Found")
        failing = ""
        const deferred = Promise.withResolvers<void>()
        recovery = deferred.promise
        const retry = [...container.querySelectorAll("button")].find(
          (button) => button.textContent === "Try Again",
        )
        expect(retry).toBeDefined()
        await act(async () => {
          retry?.click()
          await new Promise((resolve) => setTimeout(resolve, 10))
        })
        expect(container.querySelector('[role="alert"]') === null).toBe(true)
        await act(async () => {
          deferred.resolve()
        })
        await settle("Loaded item form")
      } finally {
        await act(async () => root.unmount())
        client.clear()
        dom.window.close()
        Object.assign(globalThis, original)
      }
    }
  },
)
