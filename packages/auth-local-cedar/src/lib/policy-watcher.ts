import { watch as watchFileSystem } from "node:fs"
import * as path from "node:path"
import { FileSystem } from "@effect/platform"
import { NodeFileSystem } from "@effect/platform-node"
import {
  Context,
  Effect,
  Either,
  Layer,
  PubSub,
  Ref,
  Runtime,
  Stream,
} from "effect"
import { PolicyLoadError } from "@pf/auth-policy"

const fileWatchEventName = (filename: string | Buffer): string =>
  typeof filename === "string" ? filename : filename.toString("utf8")

/**
 * Service that watches Cedar policy files and provides current policy text.
 * Emits change events when any watched file is modified.
 */
export interface PolicyWatcher {
  /**
   * Stream that emits whenever any watched policy file changes.
   * Subscribe to this to trigger policy reloads.
   */
  readonly changes: Stream.Stream<void>

  /**
   * Get the current concatenated policy text from all watched files.
   */
  readonly currentPolicies: Effect.Effect<readonly string[]>
}

export class PolicyWatcherService extends Context.Tag(
  "@pf/auth-local-cedar/PolicyWatcherService",
)<PolicyWatcherService, PolicyWatcher>() {}

/**
 * Create a layer that watches policy files and provides current policy text.
 *
 * @param basePath - Base path to resolve relative policy file paths against
 * @param policyFiles - Array of policy file paths relative to basePath
 */
export const makePolicyWatcherLayer = (
  basePath: string,
  policyFiles: readonly string[],
) =>
  Layer.provide(
    Layer.scoped(
      PolicyWatcherService,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const pubsub = yield* PubSub.unbounded<void>()
        const runtime = yield* Effect.runtime()

        // Resolve absolute paths
        const absolutePaths = policyFiles.map((f) => path.resolve(basePath, f))

        // Group watched files by parent directory so file replacement saves
        // still trigger change events.
        const watchedFilesByDirectory = new Map<string, Set<string>>()
        for (const filePath of absolutePaths) {
          const directoryPath = path.dirname(filePath)
          const watchedFiles =
            watchedFilesByDirectory.get(directoryPath) ?? new Set<string>()
          watchedFiles.add(path.basename(filePath))
          watchedFilesByDirectory.set(directoryPath, watchedFiles)
        }

        // Read all policy files
        const readPolicies = Effect.forEach(absolutePaths, (filePath) =>
          fs
            .readFileString(filePath)
            .pipe(
              Effect.mapError(
                (cause) => new PolicyLoadError({ path: filePath, cause }),
              ),
            ),
        )

        // Initial read
        const initialPolicies = yield* readPolicies
        const policiesRef = yield* Ref.make<readonly string[]>(initialPolicies)

        yield* Effect.log(
          `Watching ${absolutePaths.length} Cedar policy file(s) for changes`,
        )

        const reloadPolicies = (changedPath: string) =>
          Effect.gen(function* () {
            yield* Effect.log(`Cedar policy file changed: ${changedPath}`)

            // Try to reload all policies
            const reloadResult = yield* Effect.either(readPolicies)

            yield* Either.match(reloadResult, {
              onRight: (policies) =>
                Effect.gen(function* () {
                  yield* Ref.set(policiesRef, policies)
                  yield* PubSub.publish(pubsub, undefined)
                  yield* Effect.log("Cedar policies reloaded")
                }),
              onLeft: (error) =>
                Effect.logWarning(
                  `Failed to reload Cedar policies, keeping previous valid policies: ${error}`,
                ),
            })
          })

        const reloadTimeouts = new Map<string, ReturnType<typeof setTimeout>>()
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            for (const timeout of reloadTimeouts.values()) {
              clearTimeout(timeout)
            }
            reloadTimeouts.clear()
          }),
        )

        const scheduleReload = (changedPath: string) => {
          const existingTimeout = reloadTimeouts.get(changedPath)
          if (existingTimeout) {
            clearTimeout(existingTimeout)
          }

          reloadTimeouts.set(
            changedPath,
            setTimeout(() => {
              reloadTimeouts.delete(changedPath)

              // Once the timer fires this reload is intentionally allowed to
              // complete outside the watcher scope; pending timers are cleared
              // by the finalizer before they get this far.
              Runtime.runFork(runtime, reloadPolicies(changedPath))
            }, 100),
          )
        }

        for (const [directoryPath, watchedFiles] of watchedFilesByDirectory) {
          yield* Effect.acquireRelease(
            Effect.sync(() =>
              watchFileSystem(directoryPath, (_eventType, filename) => {
                if (!filename) {
                  for (const watchedFile of watchedFiles) {
                    scheduleReload(path.join(directoryPath, watchedFile))
                  }
                  return
                }

                const filenameString = fileWatchEventName(filename)
                if (!watchedFiles.has(filenameString)) {
                  return
                }

                scheduleReload(path.join(directoryPath, filenameString))
              }),
            ),
            (watcher) => Effect.sync(() => watcher.close()),
          )
        }

        return {
          changes: Stream.fromPubSub(pubsub),
          currentPolicies: Ref.get(policiesRef),
        }
      }),
    ),
    NodeFileSystem.layer,
  )
