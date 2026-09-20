import { describe, expect, test } from "vitest"
import {
  RXDB_INACTIVITY_THRESHOLD_MS,
  type RxDbLifecycleStorage,
  type WithRxDbResetLock,
  classifyRxDbFreshness,
  decideRxDbLifecycleEvent,
  getRxDbLastSuccessfulUseKey,
  getRxDbResetGenerationKey,
  getRxDbResetPendingKey,
  initializeRxDbLifecycle,
  invalidateRxDbScope,
  parseRxDbResetAnnouncement,
  requestRxDbResetReload,
} from "../lib/collections/rxdb-lifecycle"

const NOW_MS = 2_000_000_000_000
const scope = { databaseName: "org:one", userId: "user/two" }

class MemoryStorage implements RxDbLifecycleStorage {
  readonly values = new Map<string, string>()
  readonly writes: Array<{ key: string; value: string }> = []

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.writes.push({ key, value })
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

const immediatelyLocked: WithRxDbResetLock = (_lockName, action) => action()

const createSerialLock = (): WithRxDbResetLock => {
  let tail = Promise.resolve()
  return async (_lockName, action) => {
    const previous = tail
    let release = () => undefined
    tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await action()
    } finally {
      release()
    }
  }
}

describe("RxDB lifecycle freshness", () => {
  test("uses encoded database and user marker keys", () => {
    expect(getRxDbLastSuccessfulUseKey(scope)).toBe(
      "pf:org%3Aone:user%2Ftwo:rxdb:last-successful-use:v1",
    )
    expect(getRxDbResetGenerationKey(scope.databaseName)).toBe(
      "pf:org%3Aone:rxdb:reset-generation:v1",
    )
    expect(getRxDbResetPendingKey(scope.databaseName)).toBe(
      "pf:org%3Aone:rxdb:reset-pending:v1",
    )
  })

  test("parses only valid reset announcements", () => {
    expect(parseRxDbResetAnnouncement({ kind: "reset", generation: 4 })).toBe(4)
    expect(
      parseRxDbResetAnnouncement({ kind: "other", generation: 4 }),
    ).toBeNull()
    expect(
      parseRxDbResetAnnouncement({ kind: "reset", generation: -1 }),
    ).toBeNull()
    expect(parseRxDbResetAnnouncement("reset")).toBeNull()
  })

  test("classifies the exact five-day boundary as stale", () => {
    expect(
      classifyRxDbFreshness({
        nowMs: NOW_MS,
        rawLastSuccessfulUse: String(NOW_MS - RXDB_INACTIVITY_THRESHOLD_MS),
      }),
    ).toEqual({
      kind: "stale",
      reason: "expired",
      lastSuccessfulUseMs: NOW_MS - RXDB_INACTIVITY_THRESHOLD_MS,
    })
  })

  test("classifies one millisecond inside the threshold as fresh", () => {
    expect(
      classifyRxDbFreshness({
        nowMs: NOW_MS,
        rawLastSuccessfulUse: String(NOW_MS - RXDB_INACTIVITY_THRESHOLD_MS + 1),
      }),
    ).toEqual({
      kind: "fresh",
      lastSuccessfulUseMs: NOW_MS - RXDB_INACTIVITY_THRESHOLD_MS + 1,
    })
  })

  test.each([
    [null, "missing"],
    ["", "malformed"],
    ["not-a-timestamp", "malformed"],
    [" 123", "malformed"],
    ["1.5", "malformed"],
    ["-1", "malformed"],
    [String(Number.MAX_SAFE_INTEGER + 1), "malformed"],
    [String(NOW_MS + 1), "future"],
  ])("treats %j as stale (%s)", (rawLastSuccessfulUse, reason) => {
    expect(
      classifyRxDbFreshness({ nowMs: NOW_MS, rawLastSuccessfulUse }),
    ).toMatchObject({ kind: "stale", reason })
  })
})

describe("RxDB lifecycle initialization", () => {
  test("removes a stale database before creation and marks use only after ready", async () => {
    const storage = new MemoryStorage()
    storage.setItem(
      getRxDbLastSuccessfulUseKey(scope),
      String(NOW_MS - RXDB_INACTIVITY_THRESHOLD_MS),
    )
    storage.writes.length = 0
    const events: string[] = []
    let clockReadCount = 0

    const result = await initializeRxDbLifecycle({
      scope,
      storage,
      currentTimeMs: () => NOW_MS + clockReadCount++,
      withResetLock: immediatelyLocked,
      announceReset: (generation) => {
        events.push(`announce:${generation}`)
      },
      removeDatabase: async () => {
        events.push("remove")
      },
      createReadyDatabase: async () => {
        events.push("ready")
        return "database"
      },
      publishReadyDatabase: ({ database, generation }) => {
        events.push(`publish:${database}:${generation}`)
      },
    })

    events.push("returned")
    expect(result).toEqual({
      database: "database",
      generation: 1,
      resetPerformed: true,
    })
    expect(events).toEqual([
      "announce:1",
      "remove",
      "ready",
      "publish:database:1",
      "returned",
    ])
    expect(storage.values.get(getRxDbLastSuccessfulUseKey(scope))).toBe(
      String(NOW_MS + 1),
    )
    expect(storage.values.has(getRxDbResetPendingKey(scope.databaseName))).toBe(
      false,
    )
  })

  test("does not mark a failed initialization as successful", async () => {
    const storage = new MemoryStorage()

    await expect(
      initializeRxDbLifecycle({
        scope,
        storage,
        currentTimeMs: () => NOW_MS,
        withResetLock: immediatelyLocked,
        announceReset: () => undefined,
        removeDatabase: async () => undefined,
        createReadyDatabase: async () => {
          throw new Error("migration failed")
        },
        publishReadyDatabase: () => undefined,
      }),
    ).rejects.toThrow("migration failed")

    expect(storage.values.has(getRxDbLastSuccessfulUseKey(scope))).toBe(false)
    expect(storage.values.get(getRxDbResetPendingKey(scope.databaseName))).toBe(
      "1",
    )
  })

  test("does not mark use when the provider cannot publish readiness", async () => {
    const storage = new MemoryStorage()

    await expect(
      initializeRxDbLifecycle({
        scope,
        storage,
        currentTimeMs: () => NOW_MS,
        withResetLock: immediatelyLocked,
        announceReset: () => undefined,
        removeDatabase: async () => undefined,
        createReadyDatabase: async () => "database",
        publishReadyDatabase: () => {
          throw new Error("initialization cancelled")
        },
      }),
    ).rejects.toThrow("initialization cancelled")

    expect(storage.values.has(getRxDbLastSuccessfulUseKey(scope))).toBe(false)
    expect(storage.values.get(getRxDbResetPendingKey(scope.databaseName))).toBe(
      "1",
    )
  })

  test("serializes concurrent stale startups into one database removal", async () => {
    const storage = new MemoryStorage()
    const withResetLock = createSerialLock()
    let removalCount = 0
    let creationCount = 0
    let announcementCount = 0

    const initialize = () =>
      initializeRxDbLifecycle({
        scope,
        storage,
        currentTimeMs: () => NOW_MS,
        withResetLock,
        announceReset: () => {
          announcementCount += 1
        },
        removeDatabase: async () => {
          removalCount += 1
        },
        createReadyDatabase: async () => {
          creationCount += 1
          return `database-${creationCount}`
        },
        publishReadyDatabase: () => undefined,
      })

    const results = await Promise.all([initialize(), initialize()])

    expect(removalCount).toBe(1)
    expect(announcementCount).toBe(1)
    expect(creationCount).toBe(2)
    expect(results.map(({ resetPerformed }) => resetPerformed)).toEqual([
      true,
      false,
    ])
  })
})

describe("RxDB lifecycle activity", () => {
  test("compares freshness before touching a visible marker", () => {
    expect(
      decideRxDbLifecycleEvent({
        currentGeneration: 3,
        isResetPending: false,
        isVisible: true,
        nowMs: NOW_MS,
        observedGeneration: 3,
        rawLastSuccessfulUse: String(NOW_MS - RXDB_INACTIVITY_THRESHOLD_MS),
      }),
    ).toEqual({ kind: "request-reset" })

    expect(
      decideRxDbLifecycleEvent({
        currentGeneration: 3,
        isResetPending: false,
        isVisible: true,
        nowMs: NOW_MS,
        observedGeneration: 3,
        rawLastSuccessfulUse: String(NOW_MS - 1),
      }),
    ).toEqual({ kind: "touch" })
  })

  test("reloads for a peer generation or persisted pending reset", () => {
    expect(
      decideRxDbLifecycleEvent({
        currentGeneration: 4,
        isResetPending: false,
        isVisible: true,
        nowMs: NOW_MS,
        observedGeneration: 3,
        rawLastSuccessfulUse: String(NOW_MS - 1),
      }),
    ).toEqual({ kind: "reload-peer-reset" })

    expect(
      decideRxDbLifecycleEvent({
        currentGeneration: 3,
        isResetPending: true,
        isVisible: true,
        nowMs: NOW_MS,
        observedGeneration: 3,
        rawLastSuccessfulUse: String(NOW_MS - 1),
      }),
    ).toEqual({ kind: "reload-peer-reset" })
  })

  test("does not touch a fresh marker while hidden", () => {
    expect(
      decideRxDbLifecycleEvent({
        currentGeneration: 3,
        isResetPending: false,
        isVisible: false,
        nowMs: NOW_MS,
        observedGeneration: 3,
        rawLastSuccessfulUse: String(NOW_MS - 1),
      }),
    ).toEqual({ kind: "none" })
  })

  test("uses the time after acquiring the reset lock", async () => {
    const storage = new MemoryStorage()
    storage.setItem(
      getRxDbLastSuccessfulUseKey(scope),
      String(NOW_MS - RXDB_INACTIVITY_THRESHOLD_MS),
    )
    let announcementCount = 0

    const result = await requestRxDbResetReload({
      scope,
      storage,
      currentTimeMs: () => NOW_MS + 2,
      withResetLock: async (_lockName, action) => {
        storage.setItem(getRxDbLastSuccessfulUseKey(scope), String(NOW_MS + 1))
        return action()
      },
      announceReset: () => {
        announcementCount += 1
      },
    })

    expect(result).toEqual({ kind: "continue", generation: 0 })
    expect(announcementCount).toBe(0)
  })

  test("concurrent stale tabs announce one pending reset generation", async () => {
    const storage = new MemoryStorage()
    const withResetLock = createSerialLock()
    storage.setItem(
      getRxDbLastSuccessfulUseKey(scope),
      String(NOW_MS - RXDB_INACTIVITY_THRESHOLD_MS),
    )
    let announcementCount = 0

    const requestReset = () =>
      requestRxDbResetReload({
        scope,
        storage,
        currentTimeMs: () => NOW_MS,
        withResetLock,
        announceReset: () => {
          announcementCount += 1
        },
      })

    const results = await Promise.all([requestReset(), requestReset()])

    expect(results).toEqual([
      { kind: "reload", generation: 1 },
      { kind: "reload", generation: 1 },
    ])
    expect(announcementCount).toBe(1)
    expect(
      storage.values.get(getRxDbResetGenerationKey(scope.databaseName)),
    ).toBe("1")
    expect(storage.values.get(getRxDbResetPendingKey(scope.databaseName))).toBe(
      "1",
    )
  })
})

test("Role invalidation persists a reset for suspended peers even with a fresh cache", () => {
  const storage = new MemoryStorage()
  storage.setItem(getRxDbLastSuccessfulUseKey(scope), String(NOW_MS))
  const announcements: number[] = []
  invalidateRxDbScope({
    scope,
    storage,
    announceReset: (generation) => announcements.push(generation),
  })
  expect(announcements).toEqual([1])
  expect(storage.getItem(getRxDbResetPendingKey(scope.databaseName))).toBe("1")
  expect(
    decideRxDbLifecycleEvent({
      currentGeneration: Number(
        storage.getItem(getRxDbResetGenerationKey(scope.databaseName)),
      ),
      isResetPending: true,
      isVisible: false,
      nowMs: NOW_MS,
      observedGeneration: 0,
      rawLastSuccessfulUse: storage.getItem(getRxDbLastSuccessfulUseKey(scope)),
    }),
  ).toEqual({ kind: "reload-peer-reset" })
})

test.each(["read", "generation-write", "pending-write"])(
  "Role invalidation sends a peer-accepted reset when storage fails at %s",
  (failurePoint) => {
    const announcements: number[] = []
    const storage = new MemoryStorage()
    storage.setItem(getRxDbResetGenerationKey(scope.databaseName), "7")
    if (failurePoint === "read") {
      storage.getItem = () => {
        throw new Error("storage unavailable")
      }
    } else {
      storage.setItem = (key, value) => {
        if (
          failurePoint === "generation-write" ||
          key === getRxDbResetPendingKey(scope.databaseName)
        ) {
          throw new Error("storage unavailable")
        }
        storage.values.set(key, value)
      }
    }
    expect(() =>
      invalidateRxDbScope({
        scope,
        storage,
        announceReset: (generation) => announcements.push(generation),
      }),
    ).toThrow("storage unavailable")
    expect(announcements).toHaveLength(1)
    // This is the exact acceptance check used by the provider's peer listener.
    expect(
      parseRxDbResetAnnouncement({
        kind: "reset",
        generation: announcements[0],
      }),
    ).not.toBeNull()
  },
)
