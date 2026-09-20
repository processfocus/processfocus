import {
  Cause,
  Clock,
  Deferred,
  Effect,
  Exit,
  Option,
  type Redacted,
  SynchronizedRef,
} from "effect"
import type { XeroInvoiceError } from "./errors"

export const XERO_TOKEN_REFRESH_BUFFER_MS = 60_000

export interface XeroAccess {
  readonly accessToken: Redacted.Redacted<string>
  readonly tenantId: string
  readonly refreshAfterMs: number
}

export interface XeroAccessCache {
  readonly get: () => Effect.Effect<XeroAccess, XeroInvoiceError>
  readonly invalidate: () => Effect.Effect<void>
}

type RefreshError = XeroInvoiceError | "abandoned"

type RefreshDeferred = Deferred.Deferred<XeroAccess, RefreshError>

type CacheState =
  | { readonly _tag: "empty" }
  | { readonly _tag: "ready"; readonly value: XeroAccess }
  | {
      readonly _tag: "pending"
      readonly deferred: RefreshDeferred
    }

/**
 * Cache Custom Connection tokens until shortly before expiry and coalesce
 * concurrent refreshes onto one in-flight request.
 *
 * Cache bookkeeping stays uninterruptible so a cancelled owner cannot leave a
 * dangling deferred. Fetch and joiner await are interruptible; owner interrupt
 * abandons the in-flight entry so waiters retry instead of hanging.
 */
export const makeXeroAccessCache = (
  fetchAccess: Effect.Effect<XeroAccess, XeroInvoiceError>,
): Effect.Effect<XeroAccessCache> =>
  Effect.gen(function* () {
    const cache = yield* SynchronizedRef.make<CacheState>({ _tag: "empty" })

    const ownsPending = (
      state: CacheState,
      deferred: RefreshDeferred,
    ): boolean => state._tag === "pending" && state.deferred === deferred

    const invalidate = (): Effect.Effect<void> =>
      SynchronizedRef.set(cache, { _tag: "empty" })

    const get = (): Effect.Effect<XeroAccess, XeroInvoiceError> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const nowMs = yield* Clock.currentTimeMillis

          type Acquire =
            | { readonly _tag: "hit"; readonly value: XeroAccess }
            | {
                readonly _tag: "join"
                readonly deferred: RefreshDeferred
              }
            | {
                readonly _tag: "owner"
                readonly deferred: RefreshDeferred
              }

          const acquired = yield* SynchronizedRef.modifyEffect(
            cache,
            (state): Effect.Effect<readonly [Acquire, CacheState]> => {
              if (
                state._tag === "ready" &&
                nowMs < state.value.refreshAfterMs
              ) {
                return Effect.succeed([
                  { _tag: "hit", value: state.value },
                  state,
                ])
              }
              if (state._tag === "pending") {
                return Effect.succeed([
                  { _tag: "join", deferred: state.deferred },
                  state,
                ])
              }
              return Deferred.make<XeroAccess, RefreshError>().pipe(
                Effect.map((deferred) => [
                  { _tag: "owner", deferred },
                  { _tag: "pending", deferred },
                ]),
              )
            },
          )

          if (acquired._tag === "hit") {
            return acquired.value
          }
          if (acquired._tag === "join") {
            return yield* restore(
              Deferred.await(acquired.deferred).pipe(
                Effect.catchIf(
                  (error): error is "abandoned" => error === "abandoned",
                  () => get(),
                ),
              ),
            )
          }

          yield* Effect.yieldNow()
          const exit = yield* Effect.exit(restore(fetchAccess))

          if (Exit.isSuccess(exit)) {
            yield* Deferred.succeed(acquired.deferred, exit.value)
            yield* SynchronizedRef.update(cache, (state) =>
              ownsPending(state, acquired.deferred)
                ? { _tag: "ready" as const, value: exit.value }
                : state,
            )
            return exit.value
          }

          yield* SynchronizedRef.update(cache, (state) =>
            ownsPending(state, acquired.deferred)
              ? { _tag: "empty" as const }
              : state,
          )

          return yield* Option.match(Cause.failureOption(exit.cause), {
            onNone: () =>
              Effect.gen(function* () {
                yield* Deferred.fail(acquired.deferred, "abandoned")
                return yield* Effect.failCause(exit.cause)
              }),
            onSome: (error) =>
              Effect.gen(function* () {
                yield* Deferred.fail(acquired.deferred, error)
                return yield* error
              }),
          })
        }),
      )

    return { get, invalidate }
  })

export const refreshAfterMsFromExpiresIn = (
  nowMs: number,
  expiresInSeconds: number,
): number => nowMs + expiresInSeconds * 1000 - XERO_TOKEN_REFRESH_BUFFER_MS
