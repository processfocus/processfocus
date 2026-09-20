import { JSDOM } from "jsdom"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { type RxCollection, createRxDatabase } from "rxdb"
import { replicateRxCollection } from "rxdb/plugins/replication"
import { getRxStorageMemory } from "rxdb/plugins/storage-memory"
import type { ProviderUserSession } from "@pf/auth-session"
import { getRealtimeRecipientId } from "@pf/auth-session/realtime-recipient"
import { getSessionCacheScope } from "../lib/auth/session-cache-scope"
import {
  clearReplicationRegistry,
  refreshReplicationCredentials,
} from "../lib/collections/replication-registry"
import { expect, mock, test } from "bun:test"

const human: ProviderUserSession = {
  userId: "owner",
  email: "owner@example.test",
  orgUnitId: "org",
  orgUnitPath: "/",
  roles: ["/Worker"],
}
let session = human
let expiresAt = 2_000_000_000
let appSyncEventsHttpEndpoint = ""
const recipients: Array<string | undefined> = []
const authorities: Array<() => boolean> = []
mock.module("@/components/auth-provider", () => ({
  useAuth: () => ({ session, expiresAt }),
}))
mock.module("@/components/config-provider", () => ({
  useRuntimeConfig: () => ({
    orgId: "org",
    graphqlEndpoint: "https://example.test/graphql",
    wsEndpoint: "",
    appSyncEventsHttpEndpoint,
  }),
}))
mock.module("../lib/collections/replication-factory", () => ({
  createReplication: async ({
    collection,
    recipientId,
    isCurrent,
  }: {
    collection: RxCollection<{ id: string; updatedAt: number }>
    recipientId: string | undefined
    isCurrent: () => boolean
  }) => {
    recipients.push(recipientId)
    authorities.push(isCurrent)
    return replicateRxCollection({
      collection,
      replicationIdentifier: "session-reset",
      live: false,
      autoStart: false,
      pull: {
        handler: async () => ({ documents: [], checkpoint: { updatedAt: 0 } }),
      },
    })
  },
}))

test.each(["local", "aws"])(
  "%s collection drops old data on identity change and preserves unchanged refresh",
  async (mode) => {
    appSyncEventsHttpEndpoint = mode === "aws" ? "events.example.test" : ""
    session = human
    expiresAt = 2_000_000_000
    recipients.length = 0
    authorities.length = 0
    clearReplicationRegistry()
    const dom = new JSDOM("", { url: "https://dashboard.example.test" })
    const previousWindow = globalThis.window
    const previousDocument = globalThis.document
    const previousStorage = globalThis.localStorage
    const previousAct = globalThis.IS_REACT_ACT_ENVIRONMENT
    Reflect.set(globalThis, "window", dom.window)
    Reflect.set(globalThis, "document", dom.window.document)
    Reflect.set(globalThis, "localStorage", dom.window.localStorage)
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const db = await createRxDatabase<{
      documents: RxCollection<{ id: string; updatedAt: number }>
    }>({
      name: "collection-session-reset",
      storage: getRxStorageMemory(),
      multiInstance: false,
    })
    await db.addCollections({
      documents: {
        schema: {
          version: 0,
          primaryKey: "id",
          type: "object",
          properties: {
            id: { type: "string", maxLength: 100 },
            updatedAt: { type: "number" },
          },
          required: ["id", "updatedAt"],
        },
      },
    })
    mock.module("../lib/collections/rxdb-provider", () => ({
      useRxDb: () => ({ state: { status: "ready", db } }),
      cleanupRxDb: async () => undefined,
    }))
    const { createCollectionProvider } = await import(
      "../lib/collections/collection-provider-factory"
    )
    const provider = createCollectionProvider({
      name: "SessionTest",
      getRxCollection: () => db.documents,
      pullQueryBuilder: () => ({ query: "", variables: {} }),
      deletedField: "_deleted",
      appSyncChannel: "",
      pullResultKey: "documents",
    })
    let current: ReturnType<typeof provider.useCollection> | undefined
    let rendered = false
    function Consumer() {
      current = provider.useCollection()
      rendered = true
      return <input defaultValue="unsaved" />
    }
    const container = document.createElement("div")
    const root = createRoot(container)
    const render = async () => {
      rendered = false
      await act(async () => {
        root.render(
          <provider.Provider>
            <Consumer />
          </provider.Provider>,
        )
      })
      for (
        let attempt = 0;
        attempt < 100 && (!rendered || current?.state.status !== "ready");
        attempt++
      ) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10))
        })
      }
      if (current?.state.status !== "ready")
        throw new Error("Collection not ready")
      await current.state.collection.preload()
      return current.state.collection
    }
    try {
      await db.documents.insert({ id: "old", updatedAt: 1 })
      const old = await render()
      const oldRecreate = current?.recreateReplication
      expect(recipients.at(-1)).toBe(
        await getRealtimeRecipientId(human, expiresAt),
      )
      expect(old.get("old")).toBeDefined()
      session = { ...human, roles: [...human.roles] }
      expect(await render()).toBe(old)
      const input = container.querySelector("input")
      if (!input) throw new Error("Form not mounted")
      input.value = "unsaved user edits"
      const oldHumanAuthority = authorities.at(-1)
      const oldReplication =
        current?.state.status === "ready"
          ? current.state.replicationState
          : undefined
      await act(async () => {
        await refreshReplicationCredentials(
          expiresAt + 60,
          getSessionCacheScope(session),
        )
      })
      expiresAt += 60
      expect(await render()).toBe(old)
      expect(container.querySelector("input")).toBe(input)
      expect(input.value).toBe("unsaved user edits")
      expect(old.get("old")).toBeDefined()
      expect(oldHumanAuthority?.()).toBe(mode === "local")
      if (mode === "local" && current?.state.status === "ready")
        expect(current.state.replicationState).toBe(oldReplication)
      await db.documents.find().remove()
      session = {
        ...human,
        delegation: {
          id: "delegate",
          generationId: "one",
          name: "agent",
          expiresAt: 2_000_000_000_000,
        },
      }
      const next = await render()
      if (!oldRecreate) throw new Error("Missing recreation callback")
      await expect(
        oldRecreate({
          userId: human.userId,
          graphqlEndpoint: "https://example.test/graphql",
          wsEndpoint: "",
          appSyncEventsHttpEndpoint: "",
        }),
      ).rejects.toThrow("Replication authority changed")
      expect(recipients.at(-1)).toBe(
        await getRealtimeRecipientId(session, expiresAt),
      )
      expect(authorities[0]?.()).toBe(false)
      expect(next).not.toBe(old)
      expect(old.status).toBe("cleaned-up")
      expect(old.size).toBe(0)
      expect(next.get("old")).toBeUndefined()
      const generationOneRecipient = recipients.at(-1)
      const generationOneAuthority = authorities.at(-1)
      if (!session.delegation) throw new Error("Expected delegated session")
      session = {
        ...session,
        delegation: { ...session.delegation, generationId: "two" },
      }
      await render()
      expect(recipients.at(-1)).not.toBe(generationOneRecipient)
      expect(generationOneAuthority?.()).toBe(false)
      await expect(
        refreshReplicationCredentials(
          expiresAt + 60,
          getSessionCacheScope(human),
        ),
      ).rejects.toThrow("Replication authority changed")
      const beforeRefresh = recipients.at(-1)
      const beforeRefreshAuthority = authorities.at(-1)
      const beforeRefreshCollection =
        current?.state.status === "ready" ? current.state.collection : undefined
      await act(async () => {
        await refreshReplicationCredentials(
          expiresAt + 60,
          getSessionCacheScope(session),
        )
      })
      expiresAt += 60
      expect(await render()).toBe(beforeRefreshCollection)
      if (mode === "aws") expect(recipients.at(-1)).not.toBe(beforeRefresh)
      else expect(recipients.at(-1)).toBe(beforeRefresh)
      expect(beforeRefreshAuthority?.()).toBe(mode === "local")
      session = human
      await render()
      expect(recipients.at(-1)).toBe(
        await getRealtimeRecipientId(human, expiresAt),
      )
    } finally {
      await act(async () => {
        root.unmount()
      })
      await provider.cleanup()
      clearReplicationRegistry()
      await db.remove()
      Reflect.set(globalThis, "window", previousWindow)
      Reflect.set(globalThis, "document", previousDocument)
      Reflect.set(globalThis, "localStorage", previousStorage)
      globalThis.IS_REACT_ACT_ENVIRONMENT = previousAct
      dom.window.close()
    }
  },
)
