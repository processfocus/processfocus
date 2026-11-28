import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { JSDOM } from "jsdom"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, mock, test } from "bun:test"

mock.module("next/navigation", () => ({
  usePathname: () => window.location.pathname,
}))
mock.module("@/components/auth-provider", () => ({
  useSession: () => ({ userId: "owner" }),
}))
mock.module("@/components/config-provider", () => ({
  useRuntimeConfig: () => ({}),
}))
const recreate = mock(async () => ({ success: true, errors: [] }))
mock.module("@/lib/collections/replication-registry", () => ({
  recreateAllReplications: recreate,
}))
const { DevImportCompletedProvider } = await import(
  "../lib/dev/import-completed-query-invalidation"
)

test("an import refreshes List discovery but defers process data until the retained form closes", async () => {
  const dom = new JSDOM("<main></main>", {
    url: "http://localhost/processes/start/key-request?returnTo=/lists/register",
  })
  let deliver: ((event: MessageEvent<string>) => void) | undefined
  class Events {
    set onmessage(handler: (event: MessageEvent<string>) => void) {
      deliver = handler
    }
    close() {}
  }
  const globals = {
    window: dom.window,
    document: dom.window.document,
    EventSource: Events,
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  const saved = Object.getOwnPropertyDescriptors(globalThis)
  const env = process.env["NODE_ENV"]
  Object.assign(process.env, { NODE_ENV: "development" })
  for (const [name, value] of Object.entries(globals))
    Reflect.set(globalThis, name, value)
  const root = createRoot(dom.window.document.querySelector("main")!)
  const client = new QueryClient()
  const render = () =>
    act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <DevImportCompletedProvider>{null}</DevImportCompletedProvider>
        </QueryClientProvider>,
      ),
    )
  try {
    client.setQueryData(["availableLists"], [])
    client.setQueryData(["formMetadata"], {})
    await render()
    expect(deliver).toBeDefined()
    await act(() =>
      deliver!(
        new dom.window.MessageEvent("message", {
          data: '{"processPaths":["/key-request"]}',
        }),
      ),
    )
    expect(client.getQueryState(["availableLists"])?.isInvalidated).toBe(true)
    expect(client.getQueryState(["formMetadata"])?.isInvalidated).toBe(false)
    expect(recreate).not.toHaveBeenCalled()
    dom.window.history.replaceState(null, "", "/lists/register")
    await render()
    expect(client.getQueryState(["formMetadata"])?.isInvalidated).toBe(true)
    expect(recreate).toHaveBeenCalledTimes(1)
  } finally {
    await act(() => root.unmount())
    client.clear()
    dom.window.close()
    if (env === undefined) Reflect.deleteProperty(process.env, "NODE_ENV")
    else Object.assign(process.env, { NODE_ENV: env })
    for (const name of Object.keys(globals)) {
      const descriptor = Reflect.get(saved, name)
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
})
