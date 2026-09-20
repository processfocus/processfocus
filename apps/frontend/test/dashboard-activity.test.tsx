import { JSDOM } from "jsdom"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, test, vi } from "vitest"
import { ConfigProvider } from "../components/config-provider"
import { DashboardActivity } from "../components/dashboard-activity"
import { GraphqlClientProvider } from "../lib/graphql/client-provider"

test("read-only visible Dashboard use reports with existing cookies, pauses when hidden, and cleans up", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id='root'></div></body></html>",
    { url: "http://localhost", pretendToBeVisual: true },
  )
  const previous = { window: globalThis.window, document: globalThis.document }
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  vi.useFakeTimers()
  const requests = vi.fn(() =>
    Promise.resolve(Response.json({ data: { __typename: "Query" } })),
  )
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(requests)
  let visible = true
  Object.defineProperty(document, "visibilityState", {
    get: () => (visible ? "visible" : "hidden"),
  })
  const container = document.getElementById("root")
  if (!container) throw new Error("Missing test container")
  const root = createRoot(container)
  try {
    await act(async () =>
      root.render(
        <ConfigProvider
          value={{
            graphqlEndpoint: "http://localhost/graphql",
            wsEndpoint: "",
            appSyncEventsHttpEndpoint: "",
            orgId: "test",
            featureFlags: { newDashboard: false },
          }}
        >
          <GraphqlClientProvider>
            <DashboardActivity />
          </GraphqlClientProvider>
        </ConfigProvider>,
      ),
    )
    expect(requests).toHaveBeenCalledTimes(1)
    expect(requests).toHaveBeenLastCalledWith(
      new URL("http://localhost/graphql"),
      expect.objectContaining({
        credentials: "include",
        headers: expect.any(Headers),
      }),
    )
    expect(
      new Headers(fetchSpy.mock.calls[0]?.[1]?.headers).get(
        "x-pf-dashboard-activity",
      ),
    ).toBe("1")
    requests.mockRejectedValueOnce(new Error("Activity endpoint unavailable"))
    await act(async () => vi.advanceTimersByTime(5 * 60_000))
    expect(requests).toHaveBeenCalledTimes(2)
    visible = false
    document.dispatchEvent(new dom.window.Event("visibilitychange"))
    await act(async () => vi.advanceTimersByTime(24 * 60 * 60_000))
    expect(requests).toHaveBeenCalledTimes(2)
    visible = true
    document.dispatchEvent(new dom.window.Event("visibilitychange"))
    expect(requests).toHaveBeenCalledTimes(3)
    await act(async () => root.unmount())
    vi.advanceTimersByTime(10 * 60_000)
    expect(requests).toHaveBeenCalledTimes(3)
  } finally {
    await act(async () => root.unmount())
    fetchSpy.mockRestore()
    vi.useRealTimers()
    dom.window.close()
    Object.assign(globalThis, previous)
    delete globalThis.IS_REACT_ACT_ENVIRONMENT
  }
})
