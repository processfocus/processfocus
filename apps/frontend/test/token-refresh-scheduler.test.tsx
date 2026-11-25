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
const { AuthProvider } = await import("../components/auth-provider")

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

test("workload browser access survives the refresh window and ends at its deadline", async () => {
  const dom = new JSDOM("", { url: "https://dashboard.example.test" })
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  const previousAct = globalThis.IS_REACT_ACT_ENVIRONMENT
  Reflect.set(globalThis, "window", dom.window)
  Reflect.set(globalThis, "document", dom.window.document)
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(document, "visibilityState", { value: "visible" })
  const container = document.createElement("div")
  const root = createRoot(container)
  const request = mock(async () => Response.json({ success: false }))
  Reflect.set(globalThis, "fetch", request)
  const expiresAt = Math.floor(Date.now() / 1000) + 2
  const workloadSession = {
    userId: "owner",
    email: "owner@example.test",
    roles: [],
    orgUnitId: "org",
    orgUnitPath: "/",
    workload: {
      clientId: "ci",
      machineUserId: "machine",
      bindingId: "binding",
      repositoryId: "123",
      repositoryOwnerId: "456",
      workflowRef: "workflow",
      ref: "refs/heads/trunk",
      event: "push",
      environment: "test",
      sha: "abc",
      runId: "789",
      runAttempt: "1",
      expiresAt: expiresAt * 1000,
    },
  }
  try {
    await act(async () =>
      root.render(
        <AuthProvider session={workloadSession} expiresAt={expiresAt}>
          protected work
        </AuthProvider>,
      ),
    )
    await act(async () => {
      document.dispatchEvent(new dom.window.Event("visibilitychange"))
      await Bun.sleep(10)
    })
    expect(container.textContent).toBe("protected work")
    expect(request).not.toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()
    await act(async () => {
      await Bun.sleep(expiresAt * 1000 - Date.now() + 30)
    })
    expect(container.textContent).toBe("")
    expect(request).not.toHaveBeenCalled()
  } finally {
    await act(async () => root.unmount())
    Reflect.set(globalThis, "window", previousWindow)
    Reflect.set(globalThis, "document", previousDocument)
    globalThis.IS_REACT_ACT_ENVIRONMENT = previousAct
    dom.window.close()
  }
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
