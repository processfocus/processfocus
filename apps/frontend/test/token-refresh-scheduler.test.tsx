import { JSDOM } from "jsdom"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { getRealtimeRecipientId } from "@pf/auth-session/realtime-recipient"
import { getSessionCacheScope } from "../lib/auth/session-cache-scope"
import { afterEach, expect, mock, test } from "bun:test"

const push = mock(() => undefined)
const reconnect = mock(() => undefined)
mock.module("next/navigation", () => ({ useRouter: () => ({ push }) }))
mock.module("../lib/collections/graphql-stream", () => ({
  reconnectGraphQLStreams: reconnect,
}))
const { clearReplicationRegistry, refreshReplicationCredentials } =
  await import("../lib/collections/replication-registry")
const { TokenRefreshScheduler } = await import(
  "../components/token-refresh-scheduler"
)

const originalFetch = globalThis.fetch
const session = {
  userId: "owner",
  email: "owner@example.test",
  roles: [],
  orgUnitId: "org",
  orgUnitPath: "/",
  delegation: {
    id: "agent",
    generationId: "one",
    name: "Agent",
    expiresAt: 2_000_000_000_000,
  },
}
const cacheScope = getSessionCacheScope(session)
const onRefresh = (expiresAt: number) =>
  refreshReplicationCredentials(expiresAt, cacheScope)
const onInvalidSession = () => undefined
afterEach(() => {
  clearReplicationRegistry()
  globalThis.fetch = originalFetch
  push.mockClear()
  reconnect.mockClear()
})

test.each([
  {
    name: "same scope",
    scope: cacheScope,
    success: true,
    reconnects: 1,
    reloads: 0,
    redirects: 0,
  },
  {
    name: "new generation",
    scope: "delegation-generation-2",
    success: true,
    reconnects: 0,
    reloads: 1,
    redirects: 0,
  },
  {
    name: "human transition",
    scope: "human",
    success: true,
    reconnects: 0,
    reloads: 1,
    redirects: 0,
  },
  {
    name: "changed roles",
    scope: "restricted-roles",
    success: true,
    reconnects: 0,
    reloads: 1,
    redirects: 0,
  },
  {
    name: "invalid refresh",
    scope: "delegation-generation-1",
    success: false,
    reconnects: 0,
    reloads: 0,
    redirects: 1,
  },
])("refresh $name reconnects only the same lineage", async (scenario) => {
  const dom = new JSDOM("", { url: "https://dashboard.example.test" })
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  const previousAct = globalThis.IS_REACT_ACT_ENVIRONMENT
  const reload = mock(() => undefined)
  Reflect.set(
    globalThis,
    "window",
    new Proxy(dom.window, {
      get(target, key) {
        return key === "location" ? { reload } : Reflect.get(target, key)
      },
    }),
  )
  Reflect.set(globalThis, "document", dom.window.document)
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(document, "visibilityState", { value: "visible" })
  const root = createRoot(document.createElement("div"))
  let resolveResponse: (response: Response) => void = () => undefined
  const request = mock(
    () =>
      new Promise<Response>((resolve) => {
        resolveResponse = resolve
      }),
  )
  Reflect.set(globalThis, "fetch", request)
  const refresh = async () => {
    await act(async () => {
      document.dispatchEvent(new dom.window.Event("visibilitychange"))
    })
  }
  const respond = async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 60
    const recipientId = await getRealtimeRecipientId(session, expiresAt)
    await act(async () => {
      resolveResponse(
        Response.json({
          success: scenario.success,
          cacheScope: scenario.scope,
          expiresAt,
          recipientId,
        }),
      )
      await Bun.sleep(10)
    })
  }
  try {
    await act(async () => {
      root.render(
        <TokenRefreshScheduler
          initialExpiresAt={0}
          session={session}
          onRefresh={onRefresh}
          onInvalidSession={onInvalidSession}
        />,
      )
    })
    await refresh()
    expect(request).toHaveBeenCalledWith("/api/auth/refresh", {
      method: "POST",
      credentials: "include",
    })
    expect(reconnect).not.toHaveBeenCalled()
    await respond()
    expect(reconnect).toHaveBeenCalledTimes(scenario.reconnects)
    if (scenario.reconnects)
      expect(reconnect).toHaveBeenCalledWith(scenario.scope)
    expect(reload).toHaveBeenCalledTimes(scenario.reloads)
    expect(push).toHaveBeenCalledTimes(scenario.redirects)
    // A new mounted session starts a refresh, then logs out before it resolves.
    await act(async () => {
      root.render(
        <TokenRefreshScheduler
          key="logout-race"
          initialExpiresAt={0}
          session={session}
          onRefresh={onRefresh}
          onInvalidSession={onInvalidSession}
        />,
      )
    })
    await refresh()
    expect(request).toHaveBeenCalledTimes(2)
    await act(async () => root.unmount())
    await respond()
    expect(reconnect).toHaveBeenCalledTimes(scenario.reconnects)
    expect(reload).toHaveBeenCalledTimes(scenario.reloads)
    expect(push).toHaveBeenCalledTimes(scenario.redirects)
  } finally {
    await act(async () => root.unmount())
    Reflect.set(globalThis, "window", previousWindow)
    Reflect.set(globalThis, "document", previousDocument)
    globalThis.IS_REACT_ACT_ENVIRONMENT = previousAct
    dom.window.close()
  }
})
