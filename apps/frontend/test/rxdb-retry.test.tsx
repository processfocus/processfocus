import { JSDOM, VirtualConsole } from "jsdom"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { Session } from "@pf/auth-session"
import { getSessionCacheScope } from "../lib/auth/session-cache-scope"
import { getRxDbDatabaseName } from "../lib/collections/rxdb-database-name"

let session: Session = { userId: "user-1", clientId: "test-client" }

const mocks = {
  getRxStorageLocalstorage: vi.fn(() => ({ name: "localstorage" })),
  initializeRxDbLifecycle: vi.fn(),
  removeRxDatabase: vi.fn(),
  wrappedValidateAjvStorage: vi.fn(({ storage }) => storage),
}

vi.mock("rxdb", () => ({
  createRxDatabase: vi.fn(),
  removeRxDatabase: mocks.removeRxDatabase,
}))

vi.mock("rxdb/plugins/storage-localstorage", () => ({
  getRxStorageLocalstorage: mocks.getRxStorageLocalstorage,
}))

vi.mock("rxdb/plugins/validate-ajv", () => ({
  wrappedValidateAjvStorage: mocks.wrappedValidateAjvStorage,
}))

vi.mock("@/components/auth-provider", () => ({
  useSession: () => session,
}))

vi.mock("@/components/config-provider", () => ({
  useRuntimeConfig: () => ({ orgId: "org-1" }),
}))

vi.mock("../lib/collections/rxdb-lifecycle", () => ({
  decideRxDbLifecycleEvent: vi.fn(),
  getRxDbLastSuccessfulUseKey: vi.fn(),
  getRxDbResetChannelName: () => "rxdb-reset",
  getRxDbResetGenerationKey: vi.fn(),
  getRxDbResetPendingKey: vi.fn(),
  initializeRxDbLifecycle: mocks.initializeRxDbLifecycle,
  invalidateRxDbScope: ({
    announceReset,
  }: {
    announceReset: (generation: number) => void
  }) => announceReset(1),
  parseRxDbResetAnnouncement: (data: unknown) =>
    typeof data === "object" &&
    data !== null &&
    "kind" in data &&
    data.kind === "reset"
      ? 1
      : null,
  readRxDbResetState: vi.fn(),
  requestRxDbResetReload: vi.fn(),
  touchRxDbSuccessfulUse: vi.fn(),
}))

import {
  RxDbProvider,
  cleanupRxDb,
  clearAndReloadRxDb,
  useRxDb,
} from "../lib/collections/rxdb-provider"

describe("RxDB retry", () => {
  let cleanupDom: (() => void) | undefined

  beforeEach(() => {
    session = { userId: "user-1", clientId: "test-client" }
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    mocks.getRxStorageLocalstorage.mockClear()
    mocks.initializeRxDbLifecycle.mockReset()
    mocks.removeRxDatabase.mockReset()
    mocks.wrappedValidateAjvStorage.mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    cleanupDom?.()
    cleanupDom = undefined
  })

  test("reinitializes for effective identity changes but not unchanged session objects", async () => {
    cleanupDom = installDom()
    mocks.initializeRxDbLifecycle.mockResolvedValue(undefined)
    const container = document.createElement("div")
    const root = createRoot(container)
    const human = {
      userId: "owner",
      email: "owner@example.test",
      orgUnitId: "org",
      orgUnitPath: "/",
      roles: ["/Worker", "/Manager"],
    }
    const delegation = {
      id: "delegate",
      generationId: "one",
      name: "agent",
      expiresAt: 2_000_000_000_000,
    }
    const delegated = { ...human, delegation }
    const identities: Session[] = [
      human,
      delegated,
      human,
      delegated,
      { ...delegated, delegation: { ...delegation, id: "other" } },
      { ...delegated, delegation: { ...delegation, generationId: "two" } },
      { ...delegated, roles: ["/Worker"] },
      { ...human, roles: ["/Worker"] },
    ]
    const render = async () => {
      await act(async () => {
        root.render(
          <RxDbProvider>
            <p>Dashboard content</p>
          </RxDbProvider>,
        )
      })
    }
    try {
      for (const [index, identity] of identities.entries()) {
        session = identity
        await render()
        expect(mocks.initializeRxDbLifecycle).toHaveBeenCalledTimes(index + 1)
        expect(
          mocks.initializeRxDbLifecycle.mock.calls[index]?.[0].scope,
        ).toEqual({
          databaseName: getRxDbDatabaseName({
            orgId: "org-1",
            userId: identity.userId,
            roles: identity.roles,
          }),
          userId: getSessionCacheScope(identity),
        })
        session = { ...identity, roles: [...(identity.roles ?? [])].reverse() }
        await render()
        expect(mocks.initializeRxDbLifecycle).toHaveBeenCalledTimes(index + 1)
      }
    } finally {
      await act(async () => {
        root.unmount()
      })
    }
  })

  test("removes the named database before reloading", async () => {
    const events: string[] = []
    mocks.removeRxDatabase.mockImplementationOnce(async () => {
      events.push("remove")
      return []
    })

    await clearAndReloadRxDb({
      databaseName: "pf-org-1",
      reload: () => {
        events.push("reload")
      },
    })

    expect(mocks.removeRxDatabase.mock.calls[0]?.[0]).toBe("pf-org-1")
    expect(mocks.getRxStorageLocalstorage).toHaveBeenCalledTimes(1)
    expect(mocks.wrappedValidateAjvStorage).toHaveBeenCalledTimes(1)
    expect(events).toEqual(["remove", "reload"])
  })

  test("surfaces removal failure without reloading", async () => {
    const failure = new Error("storage unavailable")
    mocks.removeRxDatabase.mockRejectedValueOnce(failure)
    const reload = vi.fn()
    await expect(
      clearAndReloadRxDb({ databaseName: "pf-previous-role", reload }),
    ).rejects.toBe(failure)
    expect(reload).not.toHaveBeenCalled()
  })

  test("keeps the previous Role's content unmounted when cleanup and retry fail", async () => {
    cleanupDom = installDom()
    mocks.initializeRxDbLifecycle.mockResolvedValueOnce(undefined)
    mocks.removeRxDatabase.mockResolvedValueOnce([])
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    const failure = new Error("storage unavailable")
    let rejectCleanup: (reason: Error) => void = () => {
      throw new Error("cleanup has not started")
    }

    function PreviousRoleContent() {
      const { resetForRoleSwitch } = useRxDb()
      return (
        <div>
          <p>Career Counsellor Todos</p>
          <button
            type="button"
            onClick={() => {
              void resetForRoleSwitch().catch(() => undefined)
            }}
          >
            Finish Role switch
          </button>
        </div>
      )
    }

    await act(async () => {
      root.render(
        <RxDbProvider>
          <PreviousRoleContent />
        </RxDbProvider>,
      )
    })
    expect(container.textContent).toContain("Career Counsellor Todos")
    mocks.removeRxDatabase.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectCleanup = reject
        }),
    )

    await act(async () => {
      container.querySelector("button")?.click()
    })
    expect(container.textContent).not.toContain("Career Counsellor Todos")

    await act(async () => {
      rejectCleanup(failure)
    })
    expect(container.textContent).not.toContain("Career Counsellor Todos")
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Your Role changed",
    )

    mocks.removeRxDatabase.mockRejectedValueOnce(failure)
    await act(async () => {
      container.querySelector("button")?.click()
    })
    expect(container.textContent).not.toContain("Career Counsellor Todos")
    expect(container.querySelector("button")?.disabled).toBe(false)
    expect(mocks.removeRxDatabase.mock.calls.map(([name]) => name)).toEqual([
      "pf-org-1",
      getRxDbDatabaseName({
        orgId: "org-1",
        userId: "user-1",
        roles: undefined,
      }),
      getRxDbDatabaseName({
        orgId: "org-1",
        userId: "user-1",
        roles: undefined,
      }),
    ])
    await act(async () => {
      root.unmount()
    })
  })

  test("blocks both tabs when a Role switch announces a reset and cleanup fails", async () => {
    cleanupDom = installDom()
    mocks.initializeRxDbLifecycle.mockResolvedValue(undefined)
    mocks.removeRxDatabase.mockResolvedValue([])
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    function SwitchRole() {
      const { resetForRoleSwitch } = useRxDb()
      return (
        <button
          type="button"
          onClick={() => void resetForRoleSwitch().catch(() => undefined)}
        >
          Switch Role
        </button>
      )
    }
    await act(async () => {
      root.render(
        <>
          <section id="initiator">
            <RxDbProvider>
              <SwitchRole />
              <p>Previous Role Todos</p>
            </RxDbProvider>
          </section>
          <section id="peer">
            <RxDbProvider>
              <p>Previous Role Executions</p>
            </RxDbProvider>
          </section>
        </>,
      )
    })
    expect(container.textContent).toContain("Previous Role Todos")
    expect(container.textContent).toContain("Previous Role Executions")
    mocks.removeRxDatabase.mockImplementationOnce(async () => {
      // The reset reaches peers before deletion can fail.
      expect(MockBroadcastChannel.messages).toContainEqual({
        kind: "reset",
        generation: 1,
      })
      throw new Error("storage unavailable")
    })
    await act(async () => {
      container.querySelector("button")?.click()
    })
    expect(container.textContent).not.toContain("Previous Role")
    expect(container.querySelector("#initiator")?.textContent).toContain(
      "Your Role changed",
    )
    expect(container.querySelector("#peer")?.textContent).not.toContain(
      "Executions",
    )
    await act(async () => root.unmount())
  })

  test("recovers when initialization fails before opening the database", async () => {
    cleanupDom = installDom()
    mocks.initializeRxDbLifecycle.mockRejectedValueOnce(
      new DOMException("The quota has been exceeded.", "QuotaExceededError"),
    )
    mocks.removeRxDatabase.mockResolvedValueOnce([])
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <RxDbProvider>
          <p>Dashboard content</p>
        </RxDbProvider>,
      )
    })

    expect(container.textContent).toContain("Database Initialization Failed")
    expect(container.textContent).toContain("The quota has been exceeded.")

    await act(async () => {
      container.querySelector("button")?.click()
    })

    expect(mocks.removeRxDatabase.mock.calls.map(([name]) => name)).toEqual([
      "pf-org-1",
      getRxDbDatabaseName({
        orgId: "org-1",
        userId: "user-1",
        roles: undefined,
      }),
    ])

    await act(async () => {
      root.unmount()
    })
    mocks.removeRxDatabase.mockClear()
    await cleanupRxDb()
    expect(mocks.removeRxDatabase.mock.calls.map(([name]) => name)).toEqual([
      getRxDbDatabaseName({
        orgId: "org-1",
        userId: "user-1",
        roles: undefined,
      }),
    ])
  })
})

class MockBroadcastChannel {
  static readonly channels = new Set<MockBroadcastChannel>()
  static readonly messages: unknown[] = []
  private readonly listeners: Array<(event: { data: unknown }) => void> = []
  constructor(readonly name: string) {
    MockBroadcastChannel.channels.add(this)
  }
  addEventListener(
    _type: string,
    listener: (event: { data: unknown }) => void,
  ): void {
    this.listeners.push(listener)
  }
  close(): void {
    MockBroadcastChannel.channels.delete(this)
  }
  postMessage(data: unknown): void {
    MockBroadcastChannel.messages.push(data)
    for (const channel of MockBroadcastChannel.channels) {
      if (channel !== this && channel.name === this.name) {
        for (const listener of channel.listeners) listener({ data })
      }
    }
  }
}

const installDom = () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://dashboard.example.com",
    virtualConsole: new VirtualConsole(),
  })
  const previousWindow = global.window
  const previousDocument = global.document
  const previousNavigator = global.navigator
  const previousLocalStorage = global.localStorage
  const previousBroadcastChannel = global.BroadcastChannel
  const previousActEnvironment = global.IS_REACT_ACT_ENVIRONMENT

  Reflect.set(globalThis, "window", dom.window)
  Reflect.set(globalThis, "document", dom.window.document)
  Reflect.set(globalThis, "navigator", dom.window.navigator)
  Reflect.set(globalThis, "localStorage", dom.window.localStorage)
  Reflect.set(globalThis, "BroadcastChannel", MockBroadcastChannel)
  global.IS_REACT_ACT_ENVIRONMENT = true

  return () => {
    dom.window.close()
    Reflect.set(globalThis, "window", previousWindow)
    Reflect.set(globalThis, "document", previousDocument)
    Reflect.set(globalThis, "navigator", previousNavigator)
    Reflect.set(globalThis, "localStorage", previousLocalStorage)
    Reflect.set(globalThis, "BroadcastChannel", previousBroadcastChannel)
    global.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
  }
}
