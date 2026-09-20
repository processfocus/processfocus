export const RXDB_INACTIVITY_THRESHOLD_MS = 5 * 24 * 60 * 60 * 1000

export interface RxDbLifecycleScope {
  readonly databaseName: string
  readonly userId: string
}

export interface RxDbLifecycleStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export type WithRxDbResetLock = <Value>(
  lockName: string,
  action: () => Promise<Value>,
) => Promise<Value>

export type RxDbFreshness =
  | { readonly kind: "fresh"; readonly lastSuccessfulUseMs: number }
  | { readonly kind: "stale"; readonly reason: "missing" }
  | { readonly kind: "stale"; readonly reason: "malformed" }
  | { readonly kind: "stale"; readonly reason: "future" }
  | {
      readonly kind: "stale"
      readonly reason: "expired"
      readonly lastSuccessfulUseMs: number
    }

export type RxDbLifecycleEventDecision =
  | { readonly kind: "reload-peer-reset" }
  | { readonly kind: "request-reset" }
  | { readonly kind: "touch" }
  | { readonly kind: "none" }

interface ResetState {
  readonly generation: number
  readonly isPending: boolean
}

const encodeKeyPart = (value: string): string => encodeURIComponent(value)

export const getRxDbLastSuccessfulUseKey = ({
  databaseName,
  userId,
}: RxDbLifecycleScope): string =>
  `pf:${encodeKeyPart(databaseName)}:${encodeKeyPart(userId)}:rxdb:last-successful-use:v1`

export const getRxDbResetGenerationKey = (databaseName: string): string =>
  `pf:${encodeKeyPart(databaseName)}:rxdb:reset-generation:v1`

export const getRxDbResetPendingKey = (databaseName: string): string =>
  `pf:${encodeKeyPart(databaseName)}:rxdb:reset-pending:v1`

const getRxDbResetLockName = (databaseName: string): string =>
  `pf:${encodeKeyPart(databaseName)}:rxdb:reset-lock:v1`

export const getRxDbResetChannelName = (databaseName: string): string =>
  `pf:${encodeKeyPart(databaseName)}:rxdb:reset-channel:v1`

export const parseRxDbResetAnnouncement = (message: unknown): number | null => {
  if (
    typeof message !== "object" ||
    message === null ||
    !("kind" in message) ||
    message.kind !== "reset" ||
    !("generation" in message) ||
    typeof message.generation !== "number" ||
    !Number.isSafeInteger(message.generation) ||
    message.generation <= 0
  ) {
    return null
  }
  return message.generation
}

const parseCanonicalNonNegativeSafeInteger = (
  rawValue: string | null,
): number | null => {
  if (rawValue === null || !/^(0|[1-9]\d*)$/.test(rawValue)) return null
  const value = Number(rawValue)
  return Number.isSafeInteger(value) ? value : null
}

export const classifyRxDbFreshness = ({
  nowMs,
  rawLastSuccessfulUse,
}: {
  readonly nowMs: number
  readonly rawLastSuccessfulUse: string | null
}): RxDbFreshness => {
  if (rawLastSuccessfulUse === null) {
    return { kind: "stale", reason: "missing" }
  }

  const lastSuccessfulUseMs =
    parseCanonicalNonNegativeSafeInteger(rawLastSuccessfulUse)
  if (lastSuccessfulUseMs === null) {
    return { kind: "stale", reason: "malformed" }
  }
  if (lastSuccessfulUseMs > nowMs) {
    return { kind: "stale", reason: "future" }
  }
  if (nowMs - lastSuccessfulUseMs >= RXDB_INACTIVITY_THRESHOLD_MS) {
    return { kind: "stale", reason: "expired", lastSuccessfulUseMs }
  }
  return { kind: "fresh", lastSuccessfulUseMs }
}

const readResetState = ({
  databaseName,
  storage,
}: {
  readonly databaseName: string
  readonly storage: RxDbLifecycleStorage
}): ResetState => {
  const generation =
    parseCanonicalNonNegativeSafeInteger(
      storage.getItem(getRxDbResetGenerationKey(databaseName)),
    ) ?? 0
  const pendingGeneration = parseCanonicalNonNegativeSafeInteger(
    storage.getItem(getRxDbResetPendingKey(databaseName)),
  )
  return {
    generation,
    isPending: generation > 0 && pendingGeneration === generation,
  }
}

export const readRxDbResetState = readResetState

const beginReset = ({
  databaseName,
  storage,
  generation,
}: {
  readonly databaseName: string
  readonly storage: RxDbLifecycleStorage
  readonly generation: number
}): number => {
  const nextGeneration =
    generation === Number.MAX_SAFE_INTEGER ? 1 : generation + 1
  storage.setItem(
    getRxDbResetGenerationKey(databaseName),
    String(nextGeneration),
  )
  storage.setItem(getRxDbResetPendingKey(databaseName), String(nextGeneration))
  return nextGeneration
}

/** Invalidate this session's cache in active and suspended peer tabs. */
export const invalidateRxDbScope = ({
  scope,
  storage,
  announceReset,
}: {
  readonly scope: RxDbLifecycleScope
  readonly storage: RxDbLifecycleStorage
  readonly announceReset: (generation: number) => void
}): void => {
  // Peers accept any positive generation as a reset announcement, even when
  // persistence fails before we can determine the next stored generation.
  let nextGeneration = 1
  try {
    const { generation } = readResetState({
      databaseName: scope.databaseName,
      storage,
    })
    nextGeneration = beginReset({
      databaseName: scope.databaseName,
      storage,
      generation,
    })
  } finally {
    // Active peers must stop even when browser storage cannot be written.
    announceReset(nextGeneration)
  }
}

const clearPendingReset = ({
  databaseName,
  storage,
  generation,
}: {
  readonly databaseName: string
  readonly storage: RxDbLifecycleStorage
  readonly generation: number
}): void => {
  if (
    storage.getItem(getRxDbResetPendingKey(databaseName)) === String(generation)
  ) {
    storage.removeItem(getRxDbResetPendingKey(databaseName))
  }
}

const recordSuccessfulUse = ({
  scope,
  storage,
  nowMs,
}: {
  readonly scope: RxDbLifecycleScope
  readonly storage: RxDbLifecycleStorage
  readonly nowMs: number
}): void => {
  storage.setItem(getRxDbLastSuccessfulUseKey(scope), String(nowMs))
}

export const touchRxDbSuccessfulUse = recordSuccessfulUse

export async function initializeRxDbLifecycle<Database>({
  scope,
  storage,
  currentTimeMs,
  withResetLock,
  announceReset,
  removeDatabase,
  createReadyDatabase,
  publishReadyDatabase,
}: {
  readonly scope: RxDbLifecycleScope
  readonly storage: RxDbLifecycleStorage
  readonly currentTimeMs: () => number
  readonly withResetLock: WithRxDbResetLock
  readonly announceReset: (generation: number) => void
  readonly removeDatabase: () => Promise<void>
  readonly createReadyDatabase: () => Promise<Database>
  readonly publishReadyDatabase: (ready: {
    readonly database: Database
    readonly generation: number
  }) => void
}): Promise<{
  readonly database: Database
  readonly generation: number
  readonly resetPerformed: boolean
}> {
  const generationBeforeLock = readResetState({
    databaseName: scope.databaseName,
    storage,
  }).generation

  return withResetLock(getRxDbResetLockName(scope.databaseName), async () => {
    const identityKey = `pf:${encodeKeyPart(scope.databaseName)}:rxdb:identity:v1`
    const identityChanged = storage.getItem(identityKey) !== scope.userId
    let resetState = readResetState({
      databaseName: scope.databaseName,
      storage,
    })
    const freshness = classifyRxDbFreshness({
      nowMs: currentTimeMs(),
      rawLastSuccessfulUse: storage.getItem(getRxDbLastSuccessfulUseKey(scope)),
    })
    const peerCompletedResetWhileWaiting =
      !resetState.isPending && resetState.generation !== generationBeforeLock
    const needsReset =
      identityChanged ||
      resetState.isPending ||
      (freshness.kind === "stale" && !peerCompletedResetWhileWaiting)
    let resetPerformed = false

    if (needsReset) {
      if (!resetState.isPending) {
        const generation = beginReset({
          databaseName: scope.databaseName,
          storage,
          generation: resetState.generation,
        })
        resetState = { generation, isPending: true }
        announceReset(generation)
      }
      await removeDatabase()
      resetPerformed = true
    }

    const database = await createReadyDatabase()
    publishReadyDatabase({ database, generation: resetState.generation })
    storage.setItem(identityKey, scope.userId)
    recordSuccessfulUse({ scope, storage, nowMs: currentTimeMs() })
    if (resetState.isPending) {
      clearPendingReset({
        databaseName: scope.databaseName,
        storage,
        generation: resetState.generation,
      })
    }

    return {
      database,
      generation: resetState.generation,
      resetPerformed,
    }
  })
}

export const decideRxDbLifecycleEvent = ({
  currentGeneration,
  isResetPending,
  isVisible,
  nowMs,
  observedGeneration,
  rawLastSuccessfulUse,
}: {
  readonly currentGeneration: number
  readonly isResetPending: boolean
  readonly isVisible: boolean
  readonly nowMs: number
  readonly observedGeneration: number
  readonly rawLastSuccessfulUse: string | null
}): RxDbLifecycleEventDecision => {
  if (currentGeneration !== observedGeneration || isResetPending) {
    return { kind: "reload-peer-reset" }
  }
  const freshness = classifyRxDbFreshness({ nowMs, rawLastSuccessfulUse })
  if (freshness.kind === "stale") return { kind: "request-reset" }
  return isVisible ? { kind: "touch" } : { kind: "none" }
}

export async function requestRxDbResetReload({
  scope,
  storage,
  currentTimeMs,
  withResetLock,
  announceReset,
}: {
  readonly scope: RxDbLifecycleScope
  readonly storage: RxDbLifecycleStorage
  readonly currentTimeMs: () => number
  readonly withResetLock: WithRxDbResetLock
  readonly announceReset: (generation: number) => void
}): Promise<
  | { readonly kind: "reload"; readonly generation: number }
  | { readonly kind: "continue"; readonly generation: number }
> {
  const generationBeforeLock = readResetState({
    databaseName: scope.databaseName,
    storage,
  }).generation

  return withResetLock(getRxDbResetLockName(scope.databaseName), async () => {
    const resetState = readResetState({
      databaseName: scope.databaseName,
      storage,
    })
    if (
      resetState.isPending ||
      resetState.generation !== generationBeforeLock
    ) {
      return { kind: "reload", generation: resetState.generation }
    }

    const nowMs = currentTimeMs()
    const freshness = classifyRxDbFreshness({
      nowMs,
      rawLastSuccessfulUse: storage.getItem(getRxDbLastSuccessfulUseKey(scope)),
    })
    if (freshness.kind === "fresh") {
      recordSuccessfulUse({ scope, storage, nowMs })
      return { kind: "continue", generation: resetState.generation }
    }

    const generation = beginReset({
      databaseName: scope.databaseName,
      storage,
      generation: resetState.generation,
    })
    announceReset(generation)
    return { kind: "reload", generation }
  })
}
