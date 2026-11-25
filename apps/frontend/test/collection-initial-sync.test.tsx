import { useLiveQuery } from "@tanstack/react-db"
import { JSDOM } from "jsdom"
import { Suspense, act, use } from "react"
import { createRoot } from "react-dom/client"
import { type RxCollection, createRxDatabase, newRxError } from "rxdb"
import { replicateRxCollection } from "rxdb/plugins/replication"
import { getRxStorageMemory } from "rxdb/plugins/storage-memory"
import { clearReplicationRegistry } from "../lib/collections/replication-registry"
import { expect, mock, test } from "bun:test"

type Doc = { id: string; updatedAt: number }
type Page = { documents: Doc[]; checkpoint: { id: string; updatedAt: number } }
const empty: Page = { documents: [], checkpoint: { id: "", updatedAt: 0 } }
const human = {
  userId: "owner",
  email: "owner@example.test",
  orgUnitId: "org",
  orgUnitPath: "/",
  roles: ["/Administrator"],
}
let session = human
const pulls: ReturnType<typeof Promise.withResolvers<Page>>[] = []
const replications: ReturnType<
  typeof replicateRxCollection<Doc, Page["checkpoint"]>
>[] = []
mock.module("@/components/auth-provider", () => ({
  useAuth: () => ({ session, expiresAt: 2_000_000_000 }),
}))
mock.module("@/components/config-provider", () => ({
  useRuntimeConfig: () => ({
    orgId: "org",
    graphqlEndpoint: "https://example.test/graphql",
    wsEndpoint: "",
    appSyncEventsHttpEndpoint: "",
  }),
}))
mock.module("../lib/collections/replication-factory", () => ({
  createReplication: ({ collection }: { collection: RxCollection<Doc> }) => {
    const replication = replicateRxCollection<Doc, Page["checkpoint"]>({
      collection,
      replicationIdentifier: "initial-sync",
      live: true,
      waitForLeadership: false,
      retryTime: 20,
      pull: {
        batchSize: 1,
        handler: () => {
          const pull = Promise.withResolvers<Page>()
          pulls.push(pull)
          return pull.promise
        },
      },
    })
    replications.push(replication)
    return replication
  },
}))

const createDatabase = async () => {
  const db = await createRxDatabase<{ documents: RxCollection<Doc> }>({
    name: `initial-sync-${crypto.randomUUID()}`,
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
  return db
}

// This mounts the same provider/session boundary as collection-session-reset.
// Only the remote pull is controlled; persistence, adapter commits and live
// query subscriptions are real.
test.each([
  "pages",
  "empty",
  "recovery",
  "scope reset",
  "query catch-up",
  "destructive reset",
])("initial sync: %s", async (scenario) => {
  session = human
  pulls.length = 0
  replications.length = 0
  clearReplicationRegistry()
  const dom = new JSDOM("", { url: "https://dashboard.example.test" })
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    localStorage: globalThis.localStorage,
    act: globalThis.IS_REACT_ACT_ENVIRONMENT,
  }
  Reflect.set(globalThis, "window", dom.window)
  Reflect.set(globalThis, "document", dom.window.document)
  Reflect.set(globalThis, "localStorage", dom.window.localStorage)
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  let db = await createDatabase()
  const databases = [db]
  const queryGate = Promise.withResolvers<void>()
  if (scenario === "query catch-up") {
    const query = db.documents.storageInstance.query.bind(
      db.documents.storageInstance,
    )
    db.documents.storageInstance.query = async (prepared) => {
      if (prepared.query.selector._deleted === false) await queryGate.promise
      return query(prepared)
    }
  }
  mock.module("../lib/collections/rxdb-provider", () => ({
    useRxDb: () => ({ state: { status: "ready", db } }),
    cleanupRxDb: async () => {},
  }))
  const { createCollectionProvider } = await import(
    "../lib/collections/collection-provider-factory"
  )
  const provider = createCollectionProvider({
    name: "InitialSync",
    getRxCollection: () => db.documents,
    pullQueryBuilder: () => ({ query: "", variables: {} }),
    deletedField: "_deleted",
    appSyncChannel: "",
    pullResultKey: "documents",
  })
  let current: ReturnType<typeof provider.useCollection> | undefined
  const renders: Array<{ status: string; ids: string[] }> = []
  function Query() {
    const context = provider.useCollection()
    const collection = use(context.collectionPromise)
    const query = useLiveQuery({ query: (q) => q.from({ doc: collection }) })
    if (query.isReady)
      renders.push({
        status: context.initialSync?.status ?? "complete",
        ids: (query.data ?? []).map((doc) => doc.id),
      })
    return <output>{query.data?.map((doc) => doc.id).join(",")}</output>
  }
  function Consumer() {
    current = provider.useCollection()
    return (
      <Suspense>
        <Query />
      </Suspense>
    )
  }
  const container = document.createElement("div")
  const root = createRoot(container)
  const render = () =>
    act(async () => {
      root.render(
        <provider.Provider>
          <Consumer />
        </provider.Provider>,
      )
    })
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 200 && !check(); i++)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
      })
    expect(check()).toBe(true)
  }
  const resolvePull = async (index: number, page: Page) => {
    await until(() => !!pulls[index])
    await act(async () => {
      pulls[index]?.resolve(page)
    })
  }
  try {
    await render()
    await until(() => current?.state.status === "ready" && pulls.length === 1)
    expect(current?.initialSync?.status ?? "complete").toBe("loading")
    // Local availability must not wait for the network.
    await current?.collectionPromise
    expect(renders.some((render) => render.status === "complete")).toBe(false)
    if (scenario === "scope reset") {
      const old = replications[0]
      db = await createDatabase()
      databases.push(db)
      session = { ...human, roles: ["/Employee"] }
      await render()
      await until(() => pulls.length === 2)
      await resolvePull(0, {
        documents: [{ id: "previous-role", updatedAt: 1 }],
        checkpoint: { id: "previous-role", updatedAt: 1 },
      })
      await act(async () => {
        old?.subjects.error.next(newRxError("RC_PULL", {}))
      })
      expect(current?.initialSync?.status ?? "complete").toBe("loading")
      expect(container.textContent).not.toContain("previous-role")
      expect(old?.subjects.error.observers).toHaveLength(0)
      await resolvePull(1, {
        documents: [{ id: "current-role", updatedAt: 1 }],
        checkpoint: { id: "current-role", updatedAt: 1 },
      })
      await until(() => container.textContent === "current-role")
      await resolvePull(2, empty)
    } else if (scenario === "query catch-up") {
      await resolvePull(0, empty)
      await replications[0]?.awaitInitialReplication()
      expect(current?.initialSync.status).toBe("loading")
      await act(async () => queryGate.resolve())
    } else if (scenario === "empty") {
      // A stream failure does not prove a required pull failed.
      await act(async () => {
        replications[0]?.subjects.error.next(newRxError("RC_STREAM", {}))
      })
      expect(current?.initialSync?.status ?? "complete").toBe("loading")
      await resolvePull(0, empty)
    } else {
      let first = 0
      if (scenario === "recovery") {
        await act(async () => {
          pulls[0]?.reject(new Error("offline"))
        })
        await until(() => current?.initialSync.status === "error")
        await act(async () => current?.retryInitialSync())
        expect(current?.initialSync.status).toBe("loading")
        first = 1
      }
      await resolvePull(first, {
        documents: [{ id: "first", updatedAt: 1 }],
        checkpoint: { id: "first", updatedAt: 1 },
      })
      await until(() => container.textContent === "first")
      expect(current?.initialSync.status).not.toBe("complete")
      await resolvePull(first + 1, {
        documents: [{ id: "last", updatedAt: 2 }],
        checkpoint: { id: "last", updatedAt: 2 },
      })
      await until(() => container.textContent?.includes("last") === true)
      expect(current?.initialSync.status).not.toBe("complete")
      await resolvePull(first + 2, empty)
    }
    await until(() => current?.initialSync.status === "complete")
    const expected = ["pages", "recovery", "destructive reset"].includes(
      scenario,
    )
      ? ["first", "last"]
      : scenario === "scope reset"
        ? ["current-role"]
        : []
    expect(
      (await db.documents.find().exec()).map((doc) => doc.id).sort(),
    ).toEqual(expected)
    expect(renders.some((render) => render.status === "complete")).toBe(true)
    expect(
      renders
        .filter((render) => render.status === "complete")
        .every(
          (render) =>
            JSON.stringify(render.ids.sort()) === JSON.stringify(expected),
        ),
    ).toBe(true)
    // Background errors and remounts keep confirmed, usable data.
    await act(async () => {
      replications.at(-1)?.subjects.error.next(newRxError("RC_PULL", {}))
    })
    await render()
    expect(current?.initialSync.status).toBe("complete")
    if (scenario === "destructive reset") {
      const nextPull = pulls.length
      await act(async () => {
        await current?.recreateReplication({
          userId: human.userId,
          graphqlEndpoint: "https://example.test/graphql",
          wsEndpoint: "",
          appSyncEventsHttpEndpoint: "",
        })
      })
      expect(current?.initialSync.status).toBe("loading")
      await until(() => container.textContent === "")
      await resolvePull(nextPull, empty)
      await until(() => current?.initialSync.status === "complete")
      expect(await db.documents.find().exec()).toHaveLength(0)
    }
  } finally {
    queryGate.resolve()
    await act(async () => root.unmount())
    await provider.cleanup()
    for (const pull of pulls) pull.resolve(empty)
    for (const database of databases) await database.remove()
    clearReplicationRegistry()
    Reflect.set(globalThis, "window", previous.window)
    Reflect.set(globalThis, "document", previous.document)
    Reflect.set(globalThis, "localStorage", previous.localStorage)
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act
    dom.window.close()
  }
})
