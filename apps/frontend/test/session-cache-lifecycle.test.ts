import { JSDOM } from "jsdom"
import { type RxCollection, createRxDatabase, removeRxDatabase } from "rxdb"
import { getRxStorageMemory } from "rxdb/plugins/storage-memory"
import type { ProviderUserSession } from "@pf/auth-session"
import { getSessionCacheScope } from "../lib/auth/session-cache-scope"
import { shouldResetCollectionBinding } from "../lib/collections/collection-provider-scope"
import { initializeRxDbLifecycle } from "../lib/collections/rxdb-lifecycle"
import { getQueryClient } from "../lib/query-client"
import { expect, test } from "bun:test"

test("effective identity changes clear the shared RxDB and query cache, including returning identities", async () => {
  const dom = new JSDOM("", { url: "https://dashboard.example.test" })
  const previousWindow = globalThis.window
  Reflect.set(globalThis, "window", dom.window)
  const storage = getRxStorageMemory()
  const name = "session-cache-lifecycle"
  const human: ProviderUserSession = {
    userId: "owner",
    email: "owner@example.test",
    orgUnitId: "org",
    orgUnitPath: "/",
    roles: ["/Manager", "/Worker"],
  }
  const delegation = {
    id: "delegate",
    generationId: "generation-1",
    name: "agent",
    expiresAt: 2_000_000_000_000,
  }
  const delegated = { ...human, delegation }
  const sessions: ProviderUserSession[] = [
    human,
    delegated,
    human,
    delegated,
    { ...delegated, delegation: { ...delegation, id: "other" } },
    {
      ...delegated,
      delegation: { ...delegation, generationId: "generation-2" },
    },
    { ...delegated, roles: ["/Worker"] },
    { ...delegated, delegationRoleSelection: ["/Worker"] },
    human,
    { ...human, roles: ["/Worker"] },
    human,
  ]
  let previousScope: string | null = null
  let oldQueryClient = getQueryClient("initial")
  const activeCollection = {}
  try {
    for (const session of sessions) {
      const scope = getSessionCacheScope(session)
      oldQueryClient.setQueryData(["private"], "old data")
      const queryClient = getQueryClient(scope)
      expect(queryClient).not.toBe(oldQueryClient)
      expect(oldQueryClient.getQueryData(["private"])).toBeUndefined()
      expect(queryClient.getQueryData(["private"])).toBeUndefined()
      if (previousScope !== null) {
        expect(
          shouldResetCollectionBinding({
            activeCollection,
            nextCollection: activeCollection,
            activeScopeKey: previousScope,
            nextScopeKey: scope,
          }),
        ).toBe(true)
      }
      const open = () =>
        initializeRxDbLifecycle({
          scope: { orgId: "org", userId: scope },
          storage: dom.window.localStorage,
          currentTimeMs: () => 1_900_000_000_000,
          withResetLock: (_name, action) => action(),
          announceReset: () => undefined,
          removeDatabase: async () => {
            await removeRxDatabase(name, storage)
          },
          createReadyDatabase: async () => {
            const db = await createRxDatabase<{
              documents: RxCollection<{ id: string; value: string }>
            }>({
              name,
              storage,
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
                    value: { type: "string" },
                  },
                  required: ["id", "value"],
                },
              },
            })
            return db
          },
          publishReadyDatabase: () => undefined,
        })
      const changed = await open()
      expect(changed.resetPerformed).toBe(true)
      expect(await changed.database.documents.find().exec()).toHaveLength(0)
      await changed.database.documents.insert({
        id: "private",
        value: "current data",
      })
      await changed.database.close()

      const refreshed = { ...session, roles: [...session.roles].reverse() }
      expect(getSessionCacheScope(refreshed)).toBe(scope)
      expect(getQueryClient(getSessionCacheScope(refreshed))).toBe(queryClient)
      expect(
        shouldResetCollectionBinding({
          activeCollection,
          nextCollection: activeCollection,
          activeScopeKey: scope,
          nextScopeKey: getSessionCacheScope(refreshed),
        }),
      ).toBe(false)
      const unchanged = await open()
      expect(unchanged.resetPerformed).toBe(false)
      expect(
        (await unchanged.database.documents.findOne("private").exec())?.value,
      ).toBe("current data")
      await unchanged.database.close()
      previousScope = scope
      oldQueryClient = queryClient
    }
  } finally {
    oldQueryClient.clear()
    await removeRxDatabase(name, storage)
    Reflect.set(globalThis, "window", previousWindow)
    dom.window.close()
  }
})
