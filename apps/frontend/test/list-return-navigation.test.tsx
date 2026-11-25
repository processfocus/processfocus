import { JSDOM } from "jsdom"
import { renderToString } from "react-dom/server"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { ListRefreshState } from "../app/(protected)/lists/lib/list-refresh"

const router = { back: vi.fn(), push: vi.fn() }
let params = new URLSearchParams()
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  useSearchParams: () => params,
}))
vi.mock("../components/auth-provider", () => ({ useSession: () => null }))
vi.mock("../components/config-provider", () => ({
  useRuntimeConfig: () => ({ orgId: "test", graphqlEndpoint: "/graphql" }),
}))
vi.mock("../lib/auth/session-cache-scope", () => ({
  getSessionCacheScope: () => "test",
}))

const previousWindow = globalThis.window
let dom: JSDOM

afterEach(() => {
  dom.window.close()
  globalThis.window = previousWindow
  vi.clearAllMocks()
})

describe("process dialog return navigation", () => {
  test.each(["cancelled", "submitted"] as const)(
    "%s returns to the retained List and invalidates only on success",
    async (result) => {
      const { ListRefreshProvider, useListRefresh, useReturnToList } =
        await import("../app/(protected)/lists/lib/list-refresh-provider")
      const href = "/lists/things?page=2&sort=name&dir=asc"
      dom = new JSDOM("", { url: "http://localhost/processes/start/new" })
      Object.assign(globalThis, { window: dom.window })
      params = new URLSearchParams({ returnTo: href })
      let close: ((result: "cancelled" | "submitted") => boolean) | undefined
      let refresh: ListRefreshState | undefined
      function Consumer() {
        refresh = useListRefresh()
        close = useReturnToList(true)
        return null
      }
      renderToString(
        <ListRefreshProvider>
          <Consumer />
        </ListRefreshProvider>,
      )
      expect(close?.(result)).toBe(true)
      expect(dom.window.location.pathname + dom.window.location.search).toBe(
        href,
      )
      expect(router.push).not.toHaveBeenCalled()
      expect(router.back).not.toHaveBeenCalled()
      expect(refresh?.snapshot().versions.get("/things") ?? 0).toBe(
        result === "submitted" ? 1 : 0,
      )
      // A second operation from this mounted List uses Back and invalidates again.
      params.set("listReturn", refresh?.rememberReturn(href) ?? "")
      expect(close?.(result)).toBe(true)
      expect(router.back).toHaveBeenCalledTimes(1)
      expect(refresh?.snapshot().versions.get("/things") ?? 0).toBe(
        result === "submitted" ? 2 : 0,
      )
    },
  )

  test("invalid return destinations leave safe fallback navigation to the process caller", async () => {
    const { ListRefreshProvider, useReturnToList } = await import(
      "../app/(protected)/lists/lib/list-refresh-provider"
    )
    dom = new JSDOM("", { url: "http://localhost/processes/start/new" })
    Object.assign(globalThis, { window: dom.window })
    params = new URLSearchParams({
      returnTo: "https://outside.example/lists/things",
    })
    let close: ((result: "submitted") => boolean) | undefined
    function Consumer() {
      close = useReturnToList(true)
      return null
    }
    renderToString(
      <ListRefreshProvider>
        <Consumer />
      </ListRefreshProvider>,
    )
    expect(close?.("submitted")).toBe(false)
    expect(dom.window.location.pathname).toBe("/processes/start/new")
    expect(router.push).not.toHaveBeenCalled()
    expect(router.back).not.toHaveBeenCalled()
  })
})
