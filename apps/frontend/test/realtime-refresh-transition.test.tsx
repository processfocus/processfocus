import { JSDOM } from "jsdom"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { getRealtimeRecipientId } from "@pf/auth-session/realtime-recipient"
import { getSessionCacheScope } from "../lib/auth/session-cache-scope"
import {
  clearReplicationRegistry,
  getReplicationExpiry,
  refreshReplicationCredentials,
  registerReplication,
} from "../lib/collections/replication-registry"
import { expect, mock, test } from "bun:test"

const transitions: string[] = []
mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => transitions.push("login") }),
}))
mock.module("@/lib/appsync-events/reconnect-registry", () => ({
  disconnectAllAdapters: () => transitions.push("disconnect"),
}))
const { TokenRefreshScheduler } = await import(
  "../components/token-refresh-scheduler"
)
const { AuthProvider, useAuth } = await import("../components/auth-provider")
const human = {
  userId: "owner",
  email: "owner@example.test",
  roles: [],
  orgUnitId: "org",
  orgUnitPath: "/",
}

for (const cleanup of ["unmount", "clear", "rerender"]) {
  for (const pendingAt of ["fetch", "json", "renewal", "rejection"]) {
    test(`${cleanup} during ${pendingAt} settles refresh without corrupting same-scope replacement`, async () => {
      const dom = new JSDOM("", { url: "https://dashboard.example.test" })
      const previous = {
        window: globalThis.window,
        document: globalThis.document,
        fetch: globalThis.fetch,
        act: globalThis.IS_REACT_ACT_ENVIRONMENT,
      }
      Reflect.set(globalThis, "window", dom.window)
      Reflect.set(globalThis, "document", dom.window.document)
      globalThis.IS_REACT_ACT_ENVIRONMENT = true
      Object.defineProperty(document, "visibilityState", { value: "visible" })
      clearReplicationRegistry()
      transitions.length = 0
      const root = createRoot(document.createElement("div"))
      const oldGate = Promise.withResolvers<void>()
      const newGate = Promise.withResolvers<void>()
      const reachedGate = Promise.withResolvers<void>()
      const scope = getSessionCacheScope(human)
      const expiry = Math.floor(Date.now() / 1000) + 3600
      const data = {
        success: true,
        expiresAt: expiry,
        cacheScope: scope,
        recipientId: await getRealtimeRecipientId(human, expiry),
      }
      let requests = 0
      Reflect.set(globalThis, "fetch", async () => {
        requests += 1
        if (requests > 1) {
          await newGate.promise
          return Response.json(data)
        }
        if (pendingAt === "fetch" || pendingAt === "rejection") {
          reachedGate.resolve()
          await oldGate.promise
          if (pendingAt === "rejection") throw new Error("Request cancelled")
        }
        const response = Response.json(data)
        if (pendingAt === "json") {
          response.json = async () => {
            reachedGate.resolve()
            await oldGate.promise
            return data
          }
        }
        return response
      })
      const oldRefresh = mock(async () => {
        reachedGate.resolve()
        await oldGate.promise
      })
      const invalid = mock(() => {})
      try {
        await act(async () => {
          root.render(
            <TokenRefreshScheduler
              initialExpiresAt={expiry - 3540}
              session={human}
              onRefresh={oldRefresh}
              onInvalidSession={invalid}
            />,
          )
        })
        await act(async () => {
          document.dispatchEvent(new dom.window.Event("visibilitychange"))
          await reachedGate.promise
        })
        let outcome = "pending"
        void Promise.resolve(getReplicationExpiry(scope, 1)).then(
          () => {
            outcome = "resolved"
          },
          () => {
            outcome = "rejected"
          },
        )
        await act(async () => {
          if (cleanup === "clear") clearReplicationRegistry()
          root.render(
            cleanup === "rerender" ? (
              <TokenRefreshScheduler
                initialExpiresAt={expiry - 3540}
                session={human}
                onRefresh={async (nextExpiry) =>
                  refreshReplicationCredentials(nextExpiry, scope)
                }
                onInvalidSession={invalid}
              />
            ) : null,
          )
        })
        expect(outcome).toBe("rejected")
        if (cleanup !== "rerender")
          await act(async () => {
            root.render(
              <AuthProvider session={human} expiresAt={expiry - 3540}>
                <Form />
              </AuthProvider>,
            )
          })
        await act(async () => {
          document.dispatchEvent(new dom.window.Event("visibilitychange"))
        })
        const nextWaiting = getReplicationExpiry(scope, 1)
        expect(nextWaiting).toBeInstanceOf(Promise)
        await act(async () => {
          oldGate.resolve()
        })
        expect(getReplicationExpiry(scope, 1)).toBe(nextWaiting)
        expect(oldRefresh).toHaveBeenCalledTimes(
          pendingAt === "renewal" ? 1 : 0,
        )
        expect(invalid).not.toHaveBeenCalled()
        expect(transitions).toEqual([])
        await act(async () => {
          newGate.resolve()
          await nextWaiting
        })
        expect(getReplicationExpiry(scope, 1)).toBe(expiry)
      } finally {
        oldGate.resolve()
        newGate.resolve()
        await act(async () => root.unmount())
        clearReplicationRegistry()
        Reflect.set(globalThis, "window", previous.window)
        Reflect.set(globalThis, "document", previous.document)
        Reflect.set(globalThis, "fetch", previous.fetch)
        globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act
        dom.window.close()
      }
    })
  }
}
function Form() {
  const { expiresAt } = useAuth()
  return (
    <>
      <input defaultValue="draft" />
      <span>{expiresAt}</span>
    </>
  )
}

test("refresh tears down old addressing before re-entering server auth, including missing response facts", async () => {
  const dom = new JSDOM("", { url: "https://dashboard.example.test" })
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  const previousFetch = globalThis.fetch
  const previousAct = globalThis.IS_REACT_ACT_ENVIRONMENT
  Reflect.set(globalThis, "window", {
    location: { reload: () => transitions.push("reload") },
  })
  Reflect.set(globalThis, "document", dom.window.document)
  Object.defineProperty(dom.window.document, "visibilityState", {
    value: "visible",
  })
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement("div")
  const root = createRoot(container)
  let response: unknown = { success: true }
  Reflect.set(globalThis, "fetch", async () => Response.json(response))
  try {
    for (const success of [true, false]) {
      response = { success }
      transitions.length = 0
      await act(async () => {
        root.render(
          <TokenRefreshScheduler
            key={String(success)}
            initialExpiresAt={Math.floor(Date.now() / 1000) + 60}
            session={human}
            onRefresh={async () => {
              transitions.push("refresh")
            }}
            onInvalidSession={() => {
              transitions.push("invalid")
            }}
          />,
        )
      })
      await act(async () => {
        document.dispatchEvent(new dom.window.Event("visibilitychange"))
        await new Promise((resolve) => setTimeout(resolve, 10))
      })
      expect(transitions).toEqual([
        "disconnect",
        "invalid",
        success ? "reload" : "login",
      ])
    }
    const expiresAt = Math.floor(Date.now() / 1000) + 3600
    registerReplication(
      "form",
      async () => {},
      async (expiry) => {
        transitions.push(`refresh:${expiry}`)
      },
    )
    response = {
      success: true,
      expiresAt,
      cacheScope: getSessionCacheScope(human),
      recipientId: await getRealtimeRecipientId(human, expiresAt),
    }
    transitions.length = 0
    await act(async () => {
      root.render(
        <AuthProvider
          key="routine"
          session={human}
          expiresAt={expiresAt - 3540}
        >
          <Form />
        </AuthProvider>,
      )
    })
    const input = container.querySelector("input")
    if (!input) throw new Error("Missing form")
    input.value = "unsaved edits"
    await act(async () => {
      document.dispatchEvent(new dom.window.Event("visibilitychange"))
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    expect(transitions).toEqual([`refresh:${expiresAt}`])
    expect(container.querySelector("input")).toBe(input)
    expect(input.value).toBe("unsaved edits")
    expect(container.querySelector("span")?.textContent).toBe(String(expiresAt))
    transitions.length = 0
    await act(async () => {
      root.render(
        <AuthProvider key="routine" session={human} expiresAt={expiresAt + 60}>
          <Form />
        </AuthProvider>,
      )
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    expect(transitions).toEqual([`refresh:${expiresAt + 60}`])
    expect(container.querySelector("input")).toBe(input)
    expect(input.value).toBe("unsaved edits")
    await act(async () => {
      root.render(
        <AuthProvider key="expiry" session={human} expiresAt={expiresAt}>
          permitted view
        </AuthProvider>,
      )
    })
    expect(container.textContent).toBe("permitted view")
    await act(async () => {
      root.render(
        <AuthProvider
          session={{
            ...human,
            delegation: {
              id: "agent",
              generationId: "old",
              name: "Agent",
              expiresAt: Date.now() - 1,
            },
          }}
          expiresAt={expiresAt}
        >
          expired view
        </AuthProvider>,
      )
    })
    expect(container.textContent).toBe("")
    await act(async () => {
      root.render(
        <AuthProvider session={human} expiresAt={expiresAt}>
          human restored
        </AuthProvider>,
      )
    })
    expect(container.textContent).toBe("human restored")
    // A real authority change must remove the old form before navigation.
    response = {
      success: true,
      expiresAt,
      cacheScope: "different-actor",
      recipientId: human.userId,
    }
    transitions.length = 0
    await act(async () => {
      root.render(
        <AuthProvider
          key="changed"
          session={human}
          expiresAt={expiresAt - 3540}
        >
          <Form />
        </AuthProvider>,
      )
    })
    await act(async () => {
      document.dispatchEvent(new dom.window.Event("visibilitychange"))
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    expect(transitions).toEqual(["disconnect", "reload"])
    expect(container.querySelector("input")).toBeNull()
    await act(async () => {
      root.render(
        <AuthProvider
          key="changed"
          session={{ ...human, userId: "new-owner" }}
          expiresAt={expiresAt}
        >
          <Form />
        </AuthProvider>,
      )
    })
    expect(container.querySelector("input")).not.toBeNull()
    expect(container.querySelector("span")?.textContent).toBe(String(expiresAt))
  } finally {
    await act(async () => root.unmount())
    Reflect.set(globalThis, "window", previousWindow)
    Reflect.set(globalThis, "document", previousDocument)
    Reflect.set(globalThis, "fetch", previousFetch)
    globalThis.IS_REACT_ACT_ENVIRONMENT = previousAct
    dom.window.close()
    clearReplicationRegistry()
  }
})
