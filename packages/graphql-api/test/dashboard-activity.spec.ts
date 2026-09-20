import { createHmac } from "node:crypto"
import { Effect, Redacted } from "effect"
import type { ProviderUserSession } from "@pf/auth-session"
import {
  DashboardActivity,
  makeDashboardActivityLayer,
  resolveBusinessMetricDimensions,
} from "../src"
import { recordDashboardActivity } from "../src/lib/dashboard-activity"
import type { JWTPayload } from "../src/lib/types"
import { expect, test } from "bun:test"

const human: ProviderUserSession = {
  userId: "alice",
  email: " Alice@Example.COM ",
  orgUnitId: "/",
  orgUnitPath: "/",
  roles: [],
  humanSession: true,
}
const jwt = (properties: ProviderUserSession): JWTPayload => ({
  mode: "access",
  type: "providerUser",
  properties,
  aud: "graphql-api",
  iss: "https://auth.example.com",
  sub: "session-subject",
  exp: 9999999999,
})
const request = new Request("http://localhost/graphql", {
  method: "POST",
  headers: { "x-pf-dashboard-activity": "1" },
})

test("activity requires an explicit probe and verified human provenance", async () => {
  const recorded: string[] = []
  const run = (input: unknown, token: JWTPayload | undefined) =>
    Effect.runPromise(
      recordDashboardActivity(input, token).pipe(
        Effect.provideService(DashboardActivity, {
          record: (email) =>
            Effect.sync(() => {
              recorded.push(email)
            }),
        }),
      ),
    )

  await run(request, jwt(human))
  await run(
    request,
    jwt({
      ...human,
      humanSession: undefined,
      humanAuthentication: {
        method: "passkey",
        providerUserId: human.userId,
        authenticatedAt: 1,
      },
    }),
  )
  expect(recorded).toEqual([human.email, human.email])
  recorded.length = 0

  await run(request, undefined)
  await run(undefined, jwt(human))
  await run(
    new Request("http://localhost/graphql", { method: "POST" }),
    jwt(human),
  )
  await run(
    new Request("http://localhost/graphql", {
      headers: { "x-pf-dashboard-activity": "1" },
    }),
    jwt(human),
  )
  await run(request, {
    ...jwt(human),
    type: "user",
    properties: { userId: "machine", clientId: "ci" },
  })
  await run(request, jwt({ ...human, humanSession: undefined }))
  await run(
    request,
    jwt({
      ...human,
      humanSession: undefined,
      humanAuthentication: {
        method: "passkey",
        providerUserId: "someone-else",
        authenticatedAt: 1,
      },
    }),
  )
  await run(
    request,
    jwt({
      ...human,
      delegation: {
        id: "d",
        generationId: "g",
        name: "bot",
        expiresAt: 9999999999999,
      },
    }),
  )
  expect(recorded).toEqual([])
  // Unconfigured analytics remains optional for valid Dashboard traffic.
  await Effect.runPromise(recordDashboardActivity(request, jwt(human)))
})

test("real OTLP export normalizes identities across runtimes without exporting email", async () => {
  const bodies: Buffer[] = []
  const collector = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      bodies.push(Buffer.from(await request.arrayBuffer()))
      return new Response(new Uint8Array(), {
        headers: { "content-type": "application/x-protobuf" },
      })
    },
  })
  const key = "local-test-shared-key-at-least-32-bytes"
  const record = (email: string, accountId: string, project: string) =>
    Effect.runPromise(
      recordDashboardActivity(request, jwt({ ...human, email })).pipe(
        Effect.provide(
          makeDashboardActivityLayer({
            key: Redacted.make(key),
            logsUrl: new URL("/v1/logs", collector.url).href,
            headers: {},
            dimensions: resolveBusinessMetricDimensions({
              ...(accountId === "999999999999"
                ? {}
                : {
                    account: {
                      name: "Test account",
                      scope:
                        accountId === "333333333333" ? "internal" : "customer",
                    },
                  }),
              accountId,
              project,
              environment: "test",
            }),
          }),
        ),
      ),
    )
  try {
    await record(human.email, "111111111111", "one")
    await record("alice@example.com", "222222222222", "two")
    await record("alice+alias@example.com", "111111111111", "one")
    await record(human.email, "333333333333", "console")
    await record(human.email, "999999999999", "unknown")
    expect(bodies).toHaveLength(3)
    const identity = createHmac("sha256", key)
      .update("alice@example.com")
      .digest("hex")
    expect(bodies[0]?.includes(identity)).toBe(true)
    expect(bodies[1]?.includes(identity)).toBe(true)
    expect(bodies[2]?.includes(identity)).toBe(false)
    expect(
      bodies[2]?.includes(
        createHmac("sha256", key)
          .update("alice+alias@example.com")
          .digest("hex"),
      ),
    ).toBe(true)
    for (const body of bodies) {
      expect(body.includes("Alice@Example.COM")).toBe(false)
      expect(body.includes("alice@example.com")).toBe(false)
      expect(body.includes("alice+alias@example.com")).toBe(false)
      expect(body.includes(key)).toBe(false)
    }
  } finally {
    await collector.stop(true)
  }
})
