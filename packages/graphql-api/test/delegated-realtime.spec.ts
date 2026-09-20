import {
  Context,
  DateTime,
  Effect,
  FiberRef,
  Layer,
  ManagedRuntime,
} from "effect"
import type { GraphQLSchema } from "graphql"
import {
  DelegationSessionService,
  InvalidDelegationSession,
} from "@pf/auth-api"
import { CurrentPrincipal, type UserPrincipal } from "@pf/auth-policy"
import type { ProviderUserSession } from "@pf/auth-session"
import { UserDetails } from "@pf/graphql-db-operations"
import { RequestTime } from "@pf/request-time"
import {
  LocalDelegatedRealtime,
  guardRealtimeStream,
  refreshRealtimeContext,
} from "../src/lib/delegated-realtime"
import { buildCurrentPrincipal } from "../src/lib/resolver-utils"
import { makeAuthorizedStreamSubscription } from "../src/lib/rxdb/resolver-makers"
import { rejectUnsupportedDelegationHandoff } from "../src/lib/session-guards"
import type { UserContext } from "../src/lib/types"
import { describe, expect, it } from "bun:test"

const makeContext = (expiresAt = Date.now() + 120_000): UserContext => ({
  userId: "usr-owner",
  _requestTime: DateTime.unsafeMake(0),
  _userDetails: { id: "usr-owner", by: "owner@example.com" },
  jwt: {
    mode: "access",
    type: "providerUser",
    aud: "graphql-api",
    iss: "issuer",
    sub: "owner",
    iat: 0,
    exp: Math.floor(expiresAt / 1000),
    properties: {
      userId: "usr-owner",
      email: "owner@example.com",
      orgUnitId: "org",
      orgUnitPath: "/",
      roles: ["/Old"],
      delegation: {
        id: "delegation",
        generationId: "generation",
        name: "Agent",
        expiresAt,
      },
    },
  },
})

const checker = (check: DelegationSessionService["Type"]["check"]) =>
  Layer.succeed(DelegationSessionService, {
    check,
    exchange: () => Effect.fail(new InvalidDelegationSession()),
  })

const refreshed = (session: ProviderUserSession) => {
  if (!session.delegation) return Effect.fail(new InvalidDelegationSession())
  return Effect.succeed({
    ...session,
    delegation: session.delegation,
    roles: ["/Current"],
  })
}

const source = <A>(values: A[] = []) => {
  let returned = 0
  let read = 0
  const iterator: AsyncIterableIterator<A> = {
    [Symbol.asyncIterator]() {
      return this
    },
    next: () => {
      read++
      const value = values.shift()
      return value === undefined
        ? new Promise(() => {})
        : Promise.resolve({ done: false, value })
    },
    return: async () => {
      returned++
      return { done: true, value: undefined }
    },
  }
  return { iterator, returned: () => returned, read: () => read }
}

describe("local delegated realtime boundary", () => {
  it("requires both explicit local capability and a live checker", async () => {
    const context = makeContext()
    await expect(
      Effect.runPromise(refreshRealtimeContext(context)),
    ).rejects.toThrow("unavailable or invalid")
    await expect(
      Effect.runPromise(
        refreshRealtimeContext(context).pipe(
          Effect.provide(LocalDelegatedRealtime.layer),
        ),
      ),
    ).rejects.toThrow("unavailable or invalid")
    await expect(
      Effect.runPromise(
        refreshRealtimeContext(context).pipe(
          Effect.provide(checker(refreshed)),
        ),
      ),
    ).rejects.toThrow("unavailable or invalid")
  })

  it("checks each time, retaining delegated identity and immutable contexts", async () => {
    const context = makeContext()
    let calls = 0
    const layers = Layer.merge(
      LocalDelegatedRealtime.layer,
      checker((session) => {
        calls++
        return refreshed(session)
      }),
    )
    const [first, second] = await Effect.runPromise(
      Effect.all([
        refreshRealtimeContext(context),
        refreshRealtimeContext(context),
      ]).pipe(Effect.provide(layers)),
    )
    expect(calls).toBe(2)
    expect(first).not.toBe(context)
    expect(first).not.toBe(second)
    expect(context.jwt?.properties.roles).toEqual(["/Old"])
    expect(first.jwt?.properties.roles).toEqual(["/Current"])
    expect(buildCurrentPrincipal(first)?.uid).toEqual({
      type: "PF::Delegation",
      id: "delegation",
    })
    expect(DateTime.toEpochMillis(first._requestTime)).toBeGreaterThan(0)
    expect(first._userDetails.by).not.toBe("owner@example.com")
  })

  it("fails closed on checker defects and expired credentials", async () => {
    for (const check of [
      refreshed,
      () => Effect.die("private database failure"),
    ]) {
      await expect(
        Effect.runPromise(
          refreshRealtimeContext(makeContext(Date.now() - 1)).pipe(
            Effect.provide(
              Layer.merge(LocalDelegatedRealtime.layer, checker(check)),
            ),
          ),
        ),
      ).rejects.toThrow("unavailable or invalid")
    }
  })

  it("only opens transport discovery, not other delegated handoffs", async () => {
    const props = makeContext().jwt?.properties
    await expect(
      Effect.runPromise(
        rejectUnsupportedDelegationHandoff(props, "subscriptionTransport"),
      ),
    ).rejects.toThrow()
    await Effect.runPromise(
      rejectUnsupportedDelegationHandoff(props, "subscriptionTransport").pipe(
        Effect.provide(LocalDelegatedRealtime.layer),
      ),
    )
    for (const operation of [
      "requestUploadUrl",
      "requestDownloadUrl",
      "exportListCsv",
      "requestProviderUserPermissions",
    ]) {
      await expect(
        Effect.runPromise(
          rejectUnsupportedDelegationHandoff(props, operation).pipe(
            Effect.provide(LocalDelegatedRealtime.layer),
          ),
        ),
      ).rejects.toThrow()
    }
  })
})

describe("realtime stream lifecycle", () => {
  it("releases completed and failed sources", async () => {
    for (const fails of [false, true]) {
      let released = false
      const iterator: AsyncIterableIterator<string> = {
        [Symbol.asyncIterator]() {
          return this
        },
        next: async () => {
          if (fails) throw new Error("private source error")
          return { done: true, value: undefined }
        },
        return: async () => {
          released = true
          return { done: true, value: undefined }
        },
      }
      const context = makeContext()
      const stream = guardRealtimeStream(iterator, {
        context,
        refresh: async () => context,
        deliver: async (event) => event,
      })
      if (fails)
        await expect(stream.next()).rejects.toThrow(
          "Subscription authorization or delivery failed",
        )
      else expect((await stream.next()).done).toBe(true)
      expect(released).toBe(true)
    }
  })
  it("checks live authority before and after delivery and closes on revocation", async () => {
    const context = makeContext()
    const events = source(["first", "second"])
    let valid = true
    let checks = 0
    const stream = guardRealtimeStream(events.iterator, {
      context,
      refresh: async () => {
        checks++
        if (!valid) throw new Error("revoked")
        return context
      },
      deliver: async (event) => event,
    })
    expect(await stream.next()).toEqual({ done: false, value: "first" })
    expect(checks).toBe(2)
    valid = false
    await expect(stream.next()).rejects.toThrow(
      "Subscription authorization or delivery failed",
    )
    expect(events.returned()).toBe(1)
  })

  it("delivers across harmless role ordering and profile metadata changes", async () => {
    const context = makeContext()
    const props = context.jwt!.properties
    if (!("email" in props)) throw new Error("Expected provider user")
    const before = {
      ...props,
      roles: ["/Worker", "/Reader"],
      delegationRoleSelection: ["/Worker", "/Reader"],
      picture: "before.png",
    }
    const after = {
      ...before,
      roles: ["/Reader", "/Worker", "/Reader"],
      delegationRoleSelection: ["/Reader", "/Worker"],
      picture: "after.png",
      delegation: {
        name: before.delegation!.name,
        expiresAt: before.delegation!.expiresAt,
        generationId: before.delegation!.generationId,
        id: before.delegation!.id,
      },
    }
    let checks = 0
    const events = source(["visible"])
    const stream = guardRealtimeStream(events.iterator, {
      context,
      refresh: async () => ({
        ...context,
        jwt: { ...context.jwt!, properties: ++checks === 1 ? before : after },
      }),
      deliver: async (event) => event,
    })
    try {
      expect(await stream.next()).toEqual({ done: false, value: "visible" })
      expect(checks).toBe(2)
      expect(before.roles).toEqual(["/Worker", "/Reader"])
    } finally {
      await stream.return?.()
    }
  })

  it("allows a rename before delivery with the fresh Cedar principal", async () => {
    const context = makeContext()
    const props = context.jwt!.properties
    if (!("email" in props)) throw new Error("Expected provider user")
    const latest = {
      ...context,
      jwt: {
        ...context.jwt!,
        properties: {
          ...props,
          delegation: { ...props.delegation!, name: "Renamed agent" },
        },
      },
    }
    const events = source(["visible"])
    const stream = guardRealtimeStream(events.iterator, {
      context,
      refresh: async () => latest,
      deliver: async (event, fresh) => {
        const principal = buildCurrentPrincipal(fresh)
        expect(principal && "name" in principal && principal.name).toBe(
          "Renamed agent",
        )
        return event
      },
    })
    try {
      expect(await stream.next()).toEqual({ done: false, value: "visible" })
    } finally {
      await stream.return?.()
    }
  })

  it.each([
    ["role removal", { roles: [] }, undefined],
    ["role addition", { roles: ["/Old", "/New"] }, undefined],
    ["owner", { userId: "other-owner" }, undefined],
    ["Cedar owner identity", { email: "other@example.com" }, undefined],
    ["org unit", { orgUnitId: "other-org" }, undefined],
    ["Cedar org unit", { orgUnitPath: "/Other" }, undefined],
    ["role selection", { delegationRoleSelection: [] }, undefined],
    ["delegation removal", { delegation: undefined }, undefined],
    ["delegation identity", {}, { id: "other-delegation" }],
    ["generation", {}, { generationId: "other-generation" }],
    ["policy-visible name", {}, { name: "Renamed agent" }],
    ["generation deadline", {}, { expiresAt: Date.now() + 60_000 }],
  ] satisfies [
    string,
    Partial<ProviderUserSession>,
    Partial<NonNullable<ProviderUserSession["delegation"]>> | undefined,
  ][])(
    "discards a result if %s changes during resolution",
    async (_name, changes, delegationChanges) => {
      const context = makeContext()
      const props = context.jwt!.properties
      if (!("email" in props)) throw new Error("Expected provider user")
      const after = {
        ...props,
        ...changes,
        ...(delegationChanges
          ? { delegation: { ...props.delegation!, ...delegationChanges } }
          : {}),
      }
      const events = source(["secret"])
      let checks = 0
      const stream = guardRealtimeStream(events.iterator, {
        context,
        refresh: async () => {
          checks++
          return checks === 1
            ? context
            : {
                ...context,
                jwt: {
                  ...context.jwt!,
                  properties: after,
                },
              }
        },
        deliver: async (event) => event,
      })
      await expect(stream.next()).rejects.toThrow("unavailable or invalid")
      expect(events.returned()).toBe(1)
    },
  )

  it("interrupts idle reads at the credential deadline, not just generation expiry", async () => {
    const context = makeContext()
    context.jwt!.exp = (Date.now() + 30) / 1000
    const events = source<string>()
    const stream = guardRealtimeStream(events.iterator, {
      context,
      refresh: async () => context,
      deliver: async (event) => event,
    })
    await expect(stream.next()).rejects.toThrow("unavailable or invalid")
    expect(events.returned()).toBe(1)
  })

  it("interrupts blocked delivery at the generation deadline", async () => {
    const context = makeContext(Date.now() + 30)
    context.jwt!.exp = (Date.now() + 120_000) / 1000
    const events = source(["secret"])
    const stream = guardRealtimeStream(events.iterator, {
      context,
      refresh: async () => context,
      deliver: () => new Promise(() => {}),
    })
    await expect(stream.next()).rejects.toThrow("unavailable or invalid")
    expect(events.returned()).toBe(1)
  })

  it("cancels a pending read without waiting for an event", async () => {
    const context = makeContext()
    const events = source<string>()
    const stream = guardRealtimeStream(events.iterator, {
      context,
      refresh: async () => context,
      deliver: async (event) => event,
    })
    const pending = stream.next()
    await stream.return?.()
    expect(await pending).toEqual({ done: true, value: undefined })
    expect(events.read()).toBe(1)
    expect(events.returned()).toBe(1)
  })

  it("rechecks idle authority within one minute without consumer demand", async () => {
    const context = makeContext()
    const events = source<string>()
    const stream = guardRealtimeStream(events.iterator, {
      context,
      idleRecheckMs: 15,
      refresh: async () => {
        throw new Error("revoked while idle")
      },
      deliver: async (event) => event,
    })
    try {
      const deadline = Date.now() + 1_000
      while (events.returned() === 0 && Date.now() < deadline) {
        await Bun.sleep(5)
      }
      expect(events.read()).toBe(0)
      expect(events.returned()).toBe(1)
      await expect(stream.next()).rejects.toThrow("unavailable or invalid")
    } finally {
      await stream.return?.()
    }
  })
})

type TestDocument = { id: string; updatedAt: number; deleted: boolean }
class TestEvents extends Context.Tag("graphql-api/test/realtime-events")<
  TestEvents,
  {
    readonly emit: (
      event: { documents: TestDocument[] },
      schema: GraphQLSchema,
    ) => Effect.Effect<void>
    readonly subscribe: () => Effect.Effect<
      AsyncIterable<{ documents: TestDocument[] }>
    >
  }
>() {}

it("filters concurrent deliveries in separate principal and request-time fibers", async () => {
  const document = { id: "document", updatedAt: 1, deleted: false }
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Layer.succeed(RequestTime, FiberRef.unsafeMake(DateTime.unsafeMake(0))),
      Layer.succeed(
        UserDetails,
        FiberRef.unsafeMake<UserContext["_userDetails"]>({
          id: null,
          by: "SYSTEM",
        }),
      ),
      Layer.succeed(
        CurrentPrincipal,
        FiberRef.unsafeMake<UserPrincipal | null>(null),
      ),
      Layer.succeed(TestEvents, {
        emit: () => Effect.void,
        subscribe: () =>
          Effect.succeed(source([{ documents: [document] }]).iterator),
      }),
    ),
  )
  const subscription = makeAuthorizedStreamSubscription(
    TestEvents,
    "events",
    (documents, principal: UserPrincipal) =>
      Effect.gen(function* () {
        yield* Effect.yieldNow()
        expect(yield* FiberRef.get(yield* CurrentPrincipal)).toBe(principal)
        const time = DateTime.toEpochMillis(
          yield* FiberRef.get(yield* RequestTime),
        )
        expect(time).toBe(principal.roles[0]?.id === "/Allowed" ? 1 : 2)
        return principal.roles[0]?.id === "/Allowed" ? [...documents] : []
      }),
    (context) => {
      const principal = buildCurrentPrincipal(context)
      return principal
        ? Effect.succeed(principal)
        : Effect.fail("missing principal")
    },
    (effect) => runtime.runPromise(effect),
  )
  const context = (role: string, time: number): UserContext => {
    const original = makeContext()
    return {
      ...original,
      _requestTime: DateTime.unsafeMake(time),
      jwt: {
        ...original.jwt!,
        properties: { ...original.jwt!.properties, roles: [role] },
      },
    }
  }
  try {
    const events = await runtime.runPromise(subscription.subscribe())
    const iterator = events[Symbol.asyncIterator]()
    const event = await iterator.next()
    if (event.done) throw new Error("Expected source event")
    const [allowed, denied] = await Promise.all([
      event.value.prepare(context("/Allowed", 1)),
      event.value.prepare(context("/Denied", 2)),
    ])
    expect(allowed).toEqual({
      events: { documents: [document], checkpoint: undefined },
    })
    expect(denied).toBeNull()
    expect(document).toEqual({ id: "document", updatedAt: 1, deleted: false })
    await iterator.return()
  } finally {
    await runtime.dispose()
  }
})
