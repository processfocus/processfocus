import { Context, DateTime, Effect, Layer, Option } from "effect"
import { GraphQLError } from "graphql"
import { encodeDelegationAudit } from "@pf/graphql-db-operations"
import { acceptVerifiedGraphqlJwt } from "./delegation-boundary"
import { hasDelegation, isProviderUserSession } from "./session-guards"
import type { UserContext } from "./types"

/** Opt in only at the local runtime, alongside DelegationSessionService. */
export class LocalDelegatedRealtime extends Context.Tag(
  "@pf/graphql-api/LocalDelegatedRealtime",
)<LocalDelegatedRealtime, { readonly transport: "local" }>() {
  static readonly layer = Layer.succeed(LocalDelegatedRealtime, {
    transport: "local",
  })
}

export const delegatedRealtimeEnabled: Effect.Effect<boolean> =
  Effect.serviceOption(LocalDelegatedRealtime).pipe(Effect.map(Option.isSome))

const invalid = () =>
  new GraphQLError("Delegated realtime authority is unavailable or invalid", {
    extensions: { code: "UNAUTHENTICATED" },
  })

const delegatedAuthority = (context: UserContext): string => {
  const props = context.jwt?.properties
  if (!isProviderUserSession(props) || !props.delegation) throw invalid()
  // Cedar roles are sets; name is a policy-visible attribute, not just metadata.
  return JSON.stringify([
    props.userId,
    props.email,
    props.orgUnitId,
    props.orgUnitPath,
    [...new Set(props.roles)].sort(),
    props.delegationRoleSelection === undefined
      ? null
      : [...new Set(props.delegationRoleSelection)].sort(),
    props.delegation.id,
    props.delegation.generationId,
    props.delegation.name,
    props.delegation.expiresAt,
  ])
}

/** A new object per delivery: never mutate a connection's shared context. */
export const refreshRealtimeContext = (
  context: UserContext,
): Effect.Effect<UserContext, GraphQLError> =>
  Effect.gen(function* () {
    const now = yield* DateTime.now
    if (!hasDelegation(context.jwt?.properties)) {
      return { ...context, _requestTime: now }
    }
    if (!(yield* delegatedRealtimeEnabled)) return yield* Effect.fail(invalid())
    const jwt = yield* acceptVerifiedGraphqlJwt(context.jwt)
    const props = jwt?.properties
    if (!jwt || !isProviderUserSession(props) || !props.delegation) {
      return yield* Effect.fail(invalid())
    }
    if (
      DateTime.toEpochMillis(yield* DateTime.now) >=
      Math.min(jwt.exp * 1000, props.delegation.expiresAt)
    )
      return yield* Effect.fail(invalid())
    return {
      ...context,
      jwt,
      userId: props.userId,
      _requestTime: now,
      _userDetails: {
        id: props.userId,
        by: encodeDelegationAudit({
          version: 1,
          ownerUserId: props.userId,
          ownerEmail: props.email,
          delegationId: props.delegation.id,
          generationId: props.delegation.generationId,
          name: props.delegation.name,
        }),
      },
    }
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.catchAllCause(() => Effect.fail(invalid())),
  )

/** Internal source event: filtering is deferred until the fresh delivery context. */
export class RealtimeEvent {
  constructor(
    readonly prepare: (context: UserContext) => Promise<unknown | null>,
  ) {}
}

/**
 * One outstanding source read; checks continue even while the consumer is idle.
 * A separate deadline timer also covers a stuck authority check or resolver.
 */
const defaultIdleRecheckMs = 30_000
const hungAuthorityCheckMs = 10_000

export const guardRealtimeStream = <A, B>(
  source: AsyncIterable<A>,
  options: {
    readonly context: UserContext
    readonly refresh: (signal?: AbortSignal) => Promise<UserContext>
    readonly deliver: (
      event: A,
      context: UserContext,
      signal: AbortSignal,
    ) => Promise<B | null>
    /** Authority recheck interval. Defaults to defaultIdleRecheckMs. */
    readonly idleRecheckMs?: number
  },
): AsyncIterableIterator<B> => {
  const iterator = source[Symbol.asyncIterator]()
  const props = options.context.jwt?.properties
  const delegated = hasDelegation(props)
  const deadline =
    delegated && isProviderUserSession(props) && props.delegation
      ? Math.min(
          options.context.jwt?.exp ? options.context.jwt.exp * 1000 : 0,
          props.delegation.expiresAt,
        )
      : Number.POSITIVE_INFINITY
  let closed = false
  let failure: unknown
  let timer: ReturnType<typeof setTimeout> | undefined
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  const abort = new AbortController()
  const wait = <T>(pending: Promise<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      const stop = () => reject(failure ?? invalid())
      if (abort.signal.aborted) stop()
      else abort.signal.addEventListener("abort", stop, { once: true })
      // Remove each waiter's listener; racing one never-settled promise per event leaks.
      pending.then(
        (value) => {
          abort.signal.removeEventListener("abort", stop)
          resolve(value)
        },
        (error) => {
          abort.signal.removeEventListener("abort", stop)
          reject(error)
        },
      )
    })
  const close = (error?: unknown) => {
    if (closed) return
    closed = true
    failure = error
    clearTimeout(timer)
    clearTimeout(deadlineTimer)
    abort.abort()
    // Do not wait for a pending source read before asking the source to release.
    void Promise.resolve()
      .then(() => iterator.return?.())
      .catch(() => {})
  }
  const assertDeadline = () => {
    if (DateTime.toEpochMillis(DateTime.unsafeNow()) >= deadline)
      throw invalid()
  }
  const check = async () => {
    assertDeadline()
    const context = await wait(options.refresh(abort.signal))
    assertDeadline()
    return context
  }
  const idleRecheckMs = options.idleRecheckMs ?? defaultIdleRecheckMs
  const schedule = () => {
    if (!delegated || closed) return
    timer = setTimeout(() => {
      // A hung checker must not keep authority alive beyond one minute.
      const timeout = setTimeout(() => close(invalid()), hungAuthorityCheckMs)
      void check()
        .then(schedule, () => close(invalid()))
        .finally(() => clearTimeout(timeout))
    }, idleRecheckMs)
  }
  if (delegated) {
    deadlineTimer = setTimeout(
      () => close(invalid()),
      Math.max(0, deadline - DateTime.toEpochMillis(DateTime.unsafeNow())),
    )
    schedule()
  }
  return {
    [Symbol.asyncIterator]() {
      return this
    },
    async next() {
      if (closed) {
        if (failure) throw failure
        return { done: true, value: undefined }
      }
      try {
        while (!closed) {
          const event = await wait(iterator.next())
          if (event.done) {
            close()
            return { done: true, value: undefined }
          }
          const context = await check()
          const authority = delegated ? delegatedAuthority(context) : undefined
          const deliveryTimeout = delegated
            ? setTimeout(() => close(invalid()), 10_000)
            : undefined
          let value: B | null
          try {
            value = await wait(
              options.deliver(event.value, context, abort.signal),
            )
            if (delegated) {
              const latest = await check()
              // Authority changed while resolving: do not publish the stale result.
              if (delegatedAuthority(latest) !== authority) throw invalid()
            }
          } finally {
            clearTimeout(deliveryTimeout)
          }
          assertDeadline()
          if (value !== null) return { done: false, value }
        }
        return { done: true, value: undefined }
      } catch (error) {
        close(
          error instanceof GraphQLError
            ? error
            : new GraphQLError("Subscription authorization or delivery failed"),
        )
        if (!failure) return { done: true, value: undefined }
        throw failure
      }
    },
    async return() {
      close()
      return { done: true, value: undefined }
    },
    async throw(error) {
      close(error)
      throw error
    },
  }
}
