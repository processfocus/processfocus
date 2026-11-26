import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import {
  captureStdout,
  loadPfcliCommand,
  runPfcliInProcess,
  useSerializedTestState,
} from "./test-helpers"
import { afterEach, describe, expect, it } from "bun:test"

useSerializedTestState()

type ImportCycleOptions = {
  readonly databasePath?: string
  readonly issuerUrl?: string
  readonly runMigrations: boolean
  readonly ensureFrontendJwt: boolean
}

type RunImportWatch = (
  orgPath: string,
  options: {
    readonly databasePath?: string
    readonly issuerUrl?: string
    readonly debounceMs?: number
    readonly skipInitialImport?: boolean
    readonly signal?: AbortSignal
    readonly runImportOnce?: (
      orgPath: string,
      signal?: AbortSignal,
      options?: ImportCycleOptions,
    ) => Promise<void>
    readonly createWatchers?: (
      orgPath: string,
      onChange: (event: {
        readonly eventType: string
        readonly path: string
      }) => void,
    ) => readonly { readonly close: () => void }[]
  },
) => Effect.Effect<unknown>

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve
  })

  return { promise, resolve }
}

const loadRunImportWatch = async (): Promise<RunImportWatch> => {
  const module = await loadPfcliCommand<{
    runImportWatch: RunImportWatch
  }>("import")
  return module.runImportWatch
}

const tempPaths: string[] = []

afterEach(() => {
  for (const tempPath of tempPaths) {
    rmSync(tempPath, { recursive: true, force: true })
  }
  tempPaths.length = 0
})

describe("pfcli import", () => {
  it("watch mode debounces changes, reports timing, and recovers after failure", async () => {
    const runImportWatch = await loadRunImportWatch()
    const controller = new AbortController()
    const initialDone = deferred()
    const failedCycleDone = deferred()
    const recoveredCycleDone = deferred()
    let calls = 0
    let closed = false
    let emitChange:
      | ((event: { readonly eventType: string; readonly path: string }) => void)
      | undefined

    const { output } = await captureStdout(async () => {
      const watchPromise = Effect.runPromise(
        runImportWatch("/tmp/watch-org", {
          debounceMs: 5,
          signal: controller.signal,
          createWatchers: (_orgPath, onChange) => {
            emitChange = onChange
            return [
              {
                close: () => {
                  closed = true
                },
              },
            ]
          },
          runImportOnce: async () => {
            calls += 1

            if (calls === 1) {
              initialDone.resolve()
              return
            }

            if (calls === 2) {
              failedCycleDone.resolve()
              throw new Error("temporary broken save")
            }

            recoveredCycleDone.resolve()
            controller.abort()
          },
        }),
      )

      await initialDone.promise
      emitChange?.({
        eventType: "rename",
        path: "/tmp/watch-org/src/.#enrolment-enquiry.ts",
      })
      emitChange?.({
        eventType: "change",
        path: "/tmp/watch-org/src/#enrolment-enquiry.ts#",
      })
      emitChange?.({
        eventType: "change",
        path: "/tmp/watch-org/src/enrolment-enquiry.ts~",
      })
      emitChange?.({
        eventType: "change",
        path: "/tmp/watch-org/src/.enrolment-enquiry.ts.swp",
      })
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(calls).toBe(1)

      emitChange?.({ eventType: "change", path: "/tmp/watch-org/src/a.ts" })
      emitChange?.({ eventType: "change", path: "/tmp/watch-org/src/b.ts" })
      await failedCycleDone.promise
      expect(calls).toBe(2)

      emitChange?.({ eventType: "change", path: "/tmp/watch-org/src/a.ts" })
      await recoveredCycleDone.promise
      await watchPromise
    })

    expect(calls).toBe(3)
    expect(closed).toBe(true)
    expect(output).toContain("[import:watch] watching /tmp/watch-org")
    expect(output).not.toContain("ignored editor temp file")
    expect(output).not.toContain(".#enrolment-enquiry.ts")
    expect(output).not.toContain("#enrolment-enquiry.ts#")
    expect(output).not.toContain(".enrolment-enquiry.ts.swp")
    expect(output).toContain("change detected: /tmp/watch-org/src/a.ts")
    expect(output).toContain("cycle 1 completed in")
    expect(output).toContain("cycle 2 failed in")
    expect(output).toContain("temporary broken save")
    expect(output).toContain("cycle 3 completed in")
  })

  it("watch mode uses fast cycles except for migration-related changes", async () => {
    const runImportWatch = await loadRunImportWatch()
    const controller = new AbortController()
    const initialDone = deferred()
    const sourceChangeDone = deferred()
    const drizzleChangeDone = deferred()
    const cycleOptions: ImportCycleOptions[] = []
    let calls = 0
    let emitChange:
      | ((event: { readonly eventType: string; readonly path: string }) => void)
      | undefined

    const watchPromise = Effect.runPromise(
      runImportWatch("/tmp/watch-org", {
        databasePath: "/tmp/watch-custom.db",
        issuerUrl: "https://auth.example.com",
        debounceMs: 5,
        signal: controller.signal,
        createWatchers: (_orgPath, onChange) => {
          emitChange = onChange
          return [{ close: () => undefined }]
        },
        runImportOnce: async (_orgPath, _signal, options) => {
          calls += 1
          if (options) {
            cycleOptions.push(options)
          }

          if (calls === 1) {
            initialDone.resolve()
            return
          }

          if (calls === 2) {
            sourceChangeDone.resolve()
            return
          }

          drizzleChangeDone.resolve()
          controller.abort()
        },
      }),
    )

    await initialDone.promise
    emitChange?.({ eventType: "change", path: "/tmp/watch-org/src/a.ts" })
    await sourceChangeDone.promise

    emitChange?.({
      eventType: "change",
      path: "/tmp/watch-org/drizzle/0001_custom.sql",
    })
    await drizzleChangeDone.promise
    await watchPromise

    expect(cycleOptions).toEqual([
      {
        runMigrations: true,
        ensureFrontendJwt: true,
        databasePath: "/tmp/watch-custom.db",
        issuerUrl: "https://auth.example.com",
      },
      {
        runMigrations: false,
        ensureFrontendJwt: false,
        databasePath: "/tmp/watch-custom.db",
        issuerUrl: "https://auth.example.com",
      },
      {
        runMigrations: true,
        ensureFrontendJwt: true,
        databasePath: "/tmp/watch-custom.db",
        issuerUrl: "https://auth.example.com",
      },
    ])
  })

  it("watch mode can skip the initial import after startup bootstrap", async () => {
    const runImportWatch = await loadRunImportWatch()
    const controller = new AbortController()
    const watchedCycleDone = deferred()
    const cycleOptions: ImportCycleOptions[] = []
    let calls = 0
    let emitChange:
      | ((event: { readonly eventType: string; readonly path: string }) => void)
      | undefined

    const { output } = await captureStdout(async () => {
      const watchPromise = Effect.runPromise(
        runImportWatch("/tmp/watch-org", {
          debounceMs: 5,
          skipInitialImport: true,
          signal: controller.signal,
          createWatchers: (_orgPath, onChange) => {
            emitChange = onChange
            return [{ close: () => undefined }]
          },
          runImportOnce: async (_orgPath, _signal, options) => {
            calls += 1
            if (options) {
              cycleOptions.push(options)
            }
            watchedCycleDone.resolve()
            controller.abort()
          },
        }),
      )

      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(calls).toBe(0)

      emitChange?.({ eventType: "change", path: "/tmp/watch-org/src/a.ts" })
      await watchedCycleDone.promise
      await watchPromise
    })

    expect(calls).toBe(1)
    expect(cycleOptions).toEqual([
      { runMigrations: false, ensureFrontendJwt: false },
    ])
    expect(output).toContain(
      "[import:watch] initial import skipped; using completed bootstrap",
    )
    expect(output).toContain("cycle 1 completed in")
  })

  it("warns when watch-skip-initial is used without watch mode", async () => {
    const orgRoot = mkdtempSync(join(tmpdir(), "pfcli-import-no-watch-"))
    tempPaths.push(orgRoot)

    const result = await runPfcliInProcess([
      "import",
      orgRoot,
      "--watch-skip-initial",
    ])

    expect(result.output).toContain(
      "--watch-skip-initial is ignored unless --watch is also set",
    )
  })
})
