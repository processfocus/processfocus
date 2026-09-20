"use client"

import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { createRxDatabase, removeRxDatabase } from "rxdb"
import type { RxCollection, RxDatabase } from "rxdb/plugins/core"
import { addRxPlugin } from "rxdb/plugins/core"
import { RxDBDevModePlugin } from "rxdb/plugins/dev-mode"
import { RxDBMigrationSchemaPlugin } from "rxdb/plugins/migration-schema"
import { getRxStorageLocalstorage } from "rxdb/plugins/storage-localstorage"
import { wrappedValidateAjvStorage } from "rxdb/plugins/validate-ajv"
import { DatabaseErrorUI } from "./database-error-ui"
import {
  type DraftProcessExecutionDocType,
  migrationStrategies as draftProcessExecutionMigrationStrategies,
  draftProcessExecutionSchema,
} from "./draft-process-execution"
import {
  type ExecutionDocType,
  migrationStrategies as executionMigrationStrategies,
  executionSchema,
} from "./execution"
import {
  type ProcessDocType,
  migrationStrategies as processMigrationStrategies,
  processSchema,
} from "./process"
import { clearReplicationRegistry } from "./replication-registry"
import {
  getLegacyRxDbDatabaseName,
  getRxDbDatabaseName,
} from "./rxdb-database-name"
import {
  type RxDbLifecycleScope,
  type WithRxDbResetLock,
  decideRxDbLifecycleEvent,
  getRxDbLastSuccessfulUseKey,
  getRxDbResetChannelName,
  getRxDbResetGenerationKey,
  getRxDbResetPendingKey,
  initializeRxDbLifecycle,
  invalidateRxDbScope,
  parseRxDbResetAnnouncement,
  readRxDbResetState,
  requestRxDbResetReload,
  touchRxDbSuccessfulUse,
} from "./rxdb-lifecycle"
import {
  type TodoDocType,
  migrationStrategies as todoMigrationStrategies,
  todoSchema,
} from "./todo"
import { useSession } from "@/components/auth-provider"
import { useRuntimeConfig } from "@/components/config-provider"
import { getSessionCacheScope } from "@/lib/auth/session-cache-scope"

if (process.env["NODE_ENV"] === "development") {
  addRxPlugin(RxDBDevModePlugin)
}
addRxPlugin(RxDBMigrationSchemaPlugin)

type DraftProcessExecutionCollection =
  RxCollection<DraftProcessExecutionDocType>
type ExecutionCollection = RxCollection<ExecutionDocType>
type ProcessCollection = RxCollection<ProcessDocType>
type TodoCollection = RxCollection<TodoDocType>

type DatabaseCollections = {
  draftProcessExecution: DraftProcessExecutionCollection
  execution: ExecutionCollection
  process: ProcessCollection
  todo: TodoCollection
}

type ProcessFocusDatabase = RxDatabase<DatabaseCollections>

type RxDbState =
  | { status: "initializing" }
  | { status: "resetting" }
  | {
      status: "ready"
      db: ProcessFocusDatabase
      draftProcessExecutionRxCollection: DraftProcessExecutionCollection
      executionRxCollection: ExecutionCollection
      processRxCollection: ProcessCollection
      todoRxCollection: TodoCollection
    }
  | { status: "error"; error: Error }

interface RxDbContextValue {
  state: RxDbState
  resetForRoleSwitch: () => Promise<void>
}

export function RxDbProviderBoundary({
  children,
  onRetry,
  state,
}: {
  readonly children: ReactNode
  readonly onRetry: () => Promise<void>
  readonly state: RxDbState
}) {
  if (state.status === "error") {
    return <DatabaseErrorUI error={state.error} onRetry={onRetry} />
  }
  if (state.status === "resetting") return null
  return children
}

const RxDbContext = createContext<RxDbContextValue | null>(null)

// Module-level database reference for cleanup access
let moduleDbRef: ProcessFocusDatabase | null = null
let pendingDatabaseRemoval: Promise<void> = Promise.resolve()
let moduleDatabaseName: string | null = null

const SUCCESSFUL_USE_HEARTBEAT_MS = 60_000

const createRxDbStorage = () =>
  wrappedValidateAjvStorage({
    storage: getRxStorageLocalstorage(),
  })

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error))

const toReadyState = (db: ProcessFocusDatabase): RxDbState => ({
  status: "ready",
  db,
  draftProcessExecutionRxCollection: db.draftProcessExecution,
  executionRxCollection: db.execution,
  processRxCollection: db.process,
  todoRxCollection: db.todo,
})

const withBrowserResetLock: WithRxDbResetLock = (lockName, action) =>
  navigator.locks.request(lockName, { mode: "exclusive" }, () => action())

const closeDatabase = async (db: ProcessFocusDatabase): Promise<void> => {
  clearReplicationRegistry()
  await db.close()
  if (moduleDbRef === db) moduleDbRef = null
}

const removeOpenDatabase = async (db: ProcessFocusDatabase): Promise<void> => {
  clearReplicationRegistry()
  console.debug("Removing RxDb")
  await db.remove()
}

/**
 * Removes the RxDB database. Throws if removal fails.
 */
export async function cleanupRxDb({
  removeDatabaseByName,
}: {
  readonly removeDatabaseByName?: () => Promise<void>
} = {}): Promise<void> {
  const db = moduleDbRef
  clearReplicationRegistry()
  if (db) {
    await removeOpenDatabase(db)
    if (moduleDbRef === db) moduleDbRef = null
  }
  if (removeDatabaseByName) await removeDatabaseByName()
  else if (moduleDatabaseName) {
    await removeRxDatabase(moduleDatabaseName, createRxDbStorage())
  }
}

export async function clearAndReloadRxDb({
  databaseName,
  reload,
}: {
  readonly databaseName: string
  readonly reload: () => void
}): Promise<void> {
  await cleanupRxDb({
    removeDatabaseByName: async () => {
      await removeRxDatabase(databaseName, createRxDbStorage())
    },
  })
  reload()
}

export function RxDbProvider({ children }: { children: ReactNode }) {
  const { orgId } = useRuntimeConfig()
  const session = useSession()
  const scope = getSessionCacheScope(session)
  return (
    <ScopedRxDbProvider
      key={JSON.stringify([orgId, scope])}
      orgId={orgId}
      userId={scope}
      databaseName={getRxDbDatabaseName({
        orgId,
        userId: session.userId,
        roles: session.roles,
      })}
    >
      {children}
    </ScopedRxDbProvider>
  )
}

function ScopedRxDbProvider({
  children,
  orgId,
  userId,
  databaseName,
}: {
  children: ReactNode
  orgId: string
  userId: string
  databaseName: string
}) {
  const dbRef = useRef<ProcessFocusDatabase | null>(null)
  const [state, setState] = useState<RxDbState>({ status: "initializing" })
  // Once the token changes, lifecycle callbacks must never reveal the old scope.
  const roleSwitchStarted = useRef(false)
  const [roleSwitchState, setRoleSwitchState] = useState<Extract<
    RxDbState,
    { status: "resetting" | "error" }
  > | null>(null)

  const resetForRoleSwitch = useCallback(async (): Promise<void> => {
    roleSwitchStarted.current = true
    setRoleSwitchState({ status: "resetting" })
    try {
      const channel = new BroadcastChannel(
        getRxDbResetChannelName(databaseName),
      )
      try {
        invalidateRxDbScope({
          scope: { databaseName, userId },
          storage: localStorage,
          announceReset: (generation) =>
            channel.postMessage({ kind: "reset", generation }),
        })
      } finally {
        channel.close()
      }
      await clearAndReloadRxDb({
        databaseName,
        reload: () => window.location.reload(),
      })
    } catch (error) {
      setRoleSwitchState({
        status: "error",
        error: new Error(
          "Your Role changed, but we could not clear the previous Role's data. Retry to continue safely.",
        ),
      })
      throw error
    }
  }, [databaseName, userId])

  useEffect(() => {
    let cancelled = false
    let activityCheckInProgress = false
    let heartbeat: ReturnType<typeof setInterval> | null = null
    let activityListenersAttached = false
    moduleDatabaseName = databaseName
    const lifecycleScope = {
      databaseName,
      userId,
    } satisfies RxDbLifecycleScope
    const rxStorage = createRxDbStorage()
    const resetChannel = new BroadcastChannel(
      getRxDbResetChannelName(databaseName),
    )
    const observedGenerationRef = { current: 0 }
    const resetReloadStartedRef = { current: false }

    const announceReset = (generation: number): void => {
      resetChannel.postMessage({ kind: "reset", generation })
    }

    const reloadForReset = (): void => {
      if (roleSwitchStarted.current) return
      if (resetReloadStartedRef.current) return
      resetReloadStartedRef.current = true
      cancelled = true
      setState({ status: "resetting" })
      const db = dbRef.current
      dbRef.current = null
      if (db) {
        void closeDatabase(db).catch((closeError: unknown) => {
          console.error(
            "Failed to close database for coordinated reset:",
            errorMessage(closeError),
          )
        })
      }
      window.location.reload()
    }

    const checkActivityBeforeTouch = async (): Promise<void> => {
      if (
        roleSwitchStarted.current ||
        cancelled ||
        activityCheckInProgress ||
        resetReloadStartedRef.current ||
        !dbRef.current
      ) {
        return
      }
      activityCheckInProgress = true
      try {
        const nowMs = Date.now()
        const resetState = readRxDbResetState({
          databaseName: lifecycleScope.databaseName,
          storage: localStorage,
        })
        const decision = decideRxDbLifecycleEvent({
          currentGeneration: resetState.generation,
          isResetPending: resetState.isPending,
          isVisible: document.visibilityState === "visible",
          nowMs,
          observedGeneration: observedGenerationRef.current,
          rawLastSuccessfulUse: localStorage.getItem(
            getRxDbLastSuccessfulUseKey(lifecycleScope),
          ),
        })

        switch (decision.kind) {
          case "reload-peer-reset":
            reloadForReset()
            return
          case "request-reset": {
            setState({ status: "resetting" })
            const resetRequest = await requestRxDbResetReload({
              scope: lifecycleScope,
              storage: localStorage,
              currentTimeMs: Date.now,
              withResetLock: withBrowserResetLock,
              announceReset,
            })
            if (resetRequest.kind === "reload") {
              reloadForReset()
              return
            }
            observedGenerationRef.current = resetRequest.generation
            const db = dbRef.current
            if (db) setState(toReadyState(db))
            return
          }
          case "touch":
            touchRxDbSuccessfulUse({
              scope: lifecycleScope,
              storage: localStorage,
              nowMs,
            })
            return
          case "none":
            return
          default: {
            const _exhaustive: never = decision
            return _exhaustive
          }
        }
      } catch (error) {
        if (!cancelled) {
          console.error("Failed to maintain RxDB lifecycle:", error)
          setState({ status: "error", error: asError(error) })
        }
      } finally {
        activityCheckInProgress = false
      }
    }

    const handleLifecycleEvent = (): void => {
      void checkActivityBeforeTouch()
    }

    const stopHeartbeat = (): void => {
      if (!heartbeat) return
      clearInterval(heartbeat)
      heartbeat = null
    }

    const startHeartbeat = (): void => {
      if (heartbeat || document.visibilityState !== "visible") return
      heartbeat = setInterval(handleLifecycleEvent, SUCCESSFUL_USE_HEARTBEAT_MS)
    }

    const handleVisibilityChange = (): void => {
      if (document.visibilityState === "visible") startHeartbeat()
      else stopHeartbeat()
      handleLifecycleEvent()
    }

    const handleStorage = (event: StorageEvent): void => {
      if (
        event.key === getRxDbResetGenerationKey(databaseName) ||
        event.key === getRxDbResetPendingKey(databaseName)
      ) {
        handleLifecycleEvent()
      }
    }

    resetChannel.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (parseRxDbResetAnnouncement(event.data) !== null) {
        reloadForReset()
      }
    })
    window.addEventListener("storage", handleStorage)

    const initializeRxDb = async () => {
      try {
        // A scope remount must finish removing the shared database before opening it.
        await pendingDatabaseRemoval
        if (dbRef.current) {
          const db = dbRef.current
          try {
            await removeOpenDatabase(db)
          } catch (cleanupError) {
            console.error(
              "Failed to clean up database before retry:",
              errorMessage(cleanupError),
            )
          }
          dbRef.current = null
          if (moduleDbRef === db) moduleDbRef = null
        }

        if (cancelled) return

        await removeRxDatabase(getLegacyRxDbDatabaseName(orgId), rxStorage)
        if (cancelled) return

        await initializeRxDbLifecycle({
          scope: lifecycleScope,
          storage: localStorage,
          currentTimeMs: Date.now,
          withResetLock: withBrowserResetLock,
          announceReset,
          removeDatabase: async () => {
            await removeRxDatabase(databaseName, rxStorage)
          },
          createReadyDatabase: async () => {
            const db = await createRxDatabase<DatabaseCollections>({
              name: databaseName,
              storage: rxStorage,
              closeDuplicates: true,
            })

            if (cancelled) {
              if (resetReloadStartedRef.current) await db.close()
              else await db.remove()
              throw new Error("RxDB initialization cancelled")
            }

            dbRef.current = db
            moduleDbRef = db

            await db.addCollections({
              draftProcessExecution: {
                schema: draftProcessExecutionSchema,
                autoMigrate: true,
                migrationStrategies: draftProcessExecutionMigrationStrategies,
              },
              execution: {
                schema: executionSchema,
                autoMigrate: true,
                migrationStrategies: executionMigrationStrategies,
              },
              process: {
                schema: processSchema,
                autoMigrate: true,
                migrationStrategies: processMigrationStrategies,
              },
              todo: {
                schema: todoSchema,
                autoMigrate: true,
                migrationStrategies: todoMigrationStrategies,
              },
            })
            return db
          },
          publishReadyDatabase: ({ database, generation }) => {
            if (cancelled) {
              throw new Error("RxDB initialization cancelled")
            }
            observedGenerationRef.current = generation
            setState(toReadyState(database))
          },
        })

        if (cancelled) return

        document.addEventListener("visibilitychange", handleVisibilityChange)
        window.addEventListener("focus", handleLifecycleEvent)
        window.addEventListener("pageshow", handleLifecycleEvent)
        activityListenersAttached = true
        startHeartbeat()
      } catch (error) {
        if (cancelled) return

        console.error("Failed to initialize RxDB:", error)
        setState({
          status: "error",
          error: asError(error),
        })
      }
    }

    initializeRxDb()

    return () => {
      cancelled = true
      stopHeartbeat()
      if (activityListenersAttached) {
        document.removeEventListener("visibilitychange", handleVisibilityChange)
        window.removeEventListener("focus", handleLifecycleEvent)
        window.removeEventListener("pageshow", handleLifecycleEvent)
      }
      window.removeEventListener("storage", handleStorage)
      resetChannel.close()
      if (dbRef.current) {
        const db = dbRef.current
        dbRef.current = null
        if (moduleDbRef === db) moduleDbRef = null
        pendingDatabaseRemoval = removeOpenDatabase(db).catch(
          (removeError: unknown) => {
            console.error(
              "Failed to remove database:",
              errorMessage(removeError),
            )
          },
        )
      }
    }
  }, [databaseName, orgId, userId])

  const clearAndRetry = () =>
    clearAndReloadRxDb({
      databaseName,
      reload: () => window.location.reload(),
    })

  const visibleState = roleSwitchState ?? state
  const contextValue = useMemo<RxDbContextValue>(
    () => ({ state: visibleState, resetForRoleSwitch }),
    [visibleState, resetForRoleSwitch],
  )

  return (
    <RxDbContext.Provider value={contextValue}>
      <RxDbProviderBoundary state={visibleState} onRetry={clearAndRetry}>
        {children}
      </RxDbProviderBoundary>
    </RxDbContext.Provider>
  )
}

export function useRxDb() {
  const context = useContext(RxDbContext)
  if (!context) {
    throw new Error("useRxDbDatabase must be used within RxDbProvider")
  }
  return context
}

export type { ProcessFocusDatabase }
