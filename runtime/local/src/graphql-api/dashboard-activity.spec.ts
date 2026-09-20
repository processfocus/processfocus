import {
  DateTime,
  Effect,
  Layer,
  ManagedRuntime,
  Redacted,
  Schema,
} from "effect"
import { type ProviderUserSession, subjects } from "@pf/auth-session"
import { resolveBusinessMetricDimensions } from "@pf/graphql-api"
import {
  CookieAuthServiceLive,
  EncryptionServiceLive,
  KeyManagementServiceLive,
  MemoryStorageServiceLive,
  createTestApp,
  defaultResolveSubject,
  defaultTokenTtl,
  issuer,
  makeClientRegistryService,
  makeIssuerCallbacks,
  makeProviderRegistryService,
  makeSubjectsConfig,
  makeTokenTtlConfig,
  resolveIssuerClients,
} from "@pf/openauth"
import {
  makeDashboardActivityLayer,
  recordDashboardActivity,
} from "../../../../packages/graphql-api/src/lib/dashboard-activity"
import type { JWTPayload } from "../../../../packages/graphql-api/src/lib/types"
import { createClient } from "../../../../packages/openauth/src/client"
import { DummyProvider } from "../../../../packages/openauth/src/provider/dummy"
import dashboard from "../../grafana/dashboards/customer-dau.json"
import { expect, test } from "bun:test"

const logsUrl = process.env["PF_DAU_OTLP_URL"]
const lokiUrl = process.env["PF_DAU_LOKI_URL"]
const key = Redacted.make("local-test-shared-key-at-least-32-bytes")
const resultSchema = Schema.Struct({
  data: Schema.Struct({
    result: Schema.Array(
      Schema.Struct({
        metric: Schema.Record({ key: Schema.String, value: Schema.String }),
        value: Schema.Tuple(Schema.Number, Schema.String),
      }),
    ),
  }),
})
const request = new Request("http://localhost/graphql", {
  method: "POST",
  headers: { "x-pf-dashboard-activity": "1" },
})
const human: ProviderUserSession = {
  userId: "alice",
  email: " Alice@Example.COM ",
  orgUnitId: "/",
  orgUnitPath: "/",
  roles: [],
  humanSession: true,
}

// Real signed login and refresh; DummyProvider supplies the already-established
// human ceremony, exactly as the existing auth-session transport integration does.
async function login(properties: ProviderUserSession): Promise<JWTPayload> {
  const clients = await Effect.runPromise(
    resolveIssuerClients([
      { id: "frontend", redirectUris: ["https://client.example.com/callback"] },
    ]),
  )
  const authRuntime = ManagedRuntime.make(
    Layer.mergeAll(
      makeClientRegistryService(clients),
      makeProviderRegistryService({
        dummy: DummyProvider({ email: properties.email }),
      }),
      makeSubjectsConfig(subjects),
      makeTokenTtlConfig(defaultTokenTtl),
      makeIssuerCallbacks({
        start: undefined,
        success: (ctx) => ctx.subject("providerUser", properties),
        allow: () => Effect.succeed(true),
        resolveSubject: defaultResolveSubject,
        onRefreshScope: ({ currentProperties }) =>
          Effect.succeed({ properties: currentProperties }),
      }),
    ).pipe(
      Layer.provideMerge(CookieAuthServiceLive),
      Layer.provideMerge(EncryptionServiceLive),
      Layer.provideMerge(KeyManagementServiceLive),
      Layer.provideMerge(MemoryStorageServiceLive),
    ),
  )
  const auth = createTestApp(await authRuntime.runPromise(issuer), {
    runtime: await authRuntime.runtime(),
  })
  try {
    const client = createClient({
      issuer: "https://auth.example.com",
      clientID: "frontend",
      fetch: (input, init) => auth.request(input, init),
    })
    const [verifier, authorization] = await client.pkce(
      "https://client.example.com/callback",
    )
    const start = await auth.request(authorization!)
    const callback = await auth.request(start.headers.get("location")!, {
      headers: { cookie: start.headers.get("set-cookie")! },
    })
    const code = new URL(callback.headers.get("location")!).searchParams.get(
      "code",
    )!
    const exchange = await client.exchange(
      code,
      "https://client.example.com/callback",
      verifier,
    )
    if (exchange.err) throw exchange.err
    const refresh = await client.refresh(exchange.tokens.refresh)
    if (refresh.err) throw refresh.err
    const verified = await client.verify(subjects, refresh.tokens!.access)
    if (verified.err) throw verified.err
    return {
      mode: "access",
      type: verified.subject.type,
      properties: verified.subject.properties,
      aud: "graphql-api",
      iss: "https://auth.example.com",
      sub: "unused-session-subject",
      exp: 9999999999,
    }
  } finally {
    await authRuntime.dispose()
  }
}

const query = async (expr: string) => {
  const url = new URL(`${lokiUrl}/loki/api/v1/query`)
  url.searchParams.set("query", expr)
  const response = await fetch(url)
  const body = await response.text()
  if (!response.ok) throw new Error(body)
  return Schema.decodeUnknownSync(Schema.parseJson(resultSchema))(body).data
    .result
}

const panelQuery = (
  index: number,
  project: string,
  account = ".*",
  environment = ".*",
) =>
  dashboard.panels[index]!.targets[0]!.expr.replaceAll(
    `\${account:regex}`,
    account,
  )
    .replaceAll(`\${project:regex}`, project)
    .replaceAll(`\${environment:regex}`, environment)
    .replaceAll("$__range", "30d")

const integration = logsUrl && lokiUrl ? test : test.skip
integration(
  "signed existing human activity exports filtered UTC distinct DAU without identity labels",
  async () => {
    const prefix = `dau-${crypto.randomUUID()}`
    const alice = await login(human)
    const normalized = await login({
      ...human,
      userId: "another-local-id",
      email: "alice@example.com",
    })
    const bob = await login({
      ...human,
      userId: "bob",
      email: "alice+alias@example.com",
    })
    const machine = await login({
      ...human,
      email: "machine@example.com",
      humanSession: undefined,
    })
    const yesterday = DateTime.unsafeMake(
      Math.floor(DateTime.toEpochMillis(DateTime.unsafeNow()) / 86400000) *
        86400000 -
        1,
    )
    const runtimes: ReturnType<
      typeof ManagedRuntime.make<
        import("../../../../packages/graphql-api/src/lib/dashboard-activity").DashboardActivity,
        never
      >
    >[] = []
    const runtimeFor = (
      accountId: string,
      project: string,
      environment: string,
    ) => {
      const runtime = ManagedRuntime.make(
        makeDashboardActivityLayer({
          key,
          logsUrl: logsUrl!,
          headers: {},
          dimensions: resolveBusinessMetricDimensions({
            account: {
              name: "Test account",
              scope: accountId === "333333333333" ? "internal" : "customer",
            },
            accountId,
            project: `${prefix}-${project}`,
            environment,
          }),
        }),
      )
      runtimes.push(runtime)
      return runtime
    }
    try {
      const dev = runtimeFor("111111111111", "one", "dev")
      const prod = runtimeFor("111111111111", "one", "prod")
      const two = runtimeFor("222222222222", "two", "staging")
      await dev.runPromise(
        recordDashboardActivity(request, alice).pipe(
          Effect.withClock({
            ...(await Effect.runPromise(Effect.clockWith(Effect.succeed))),
            currentTimeMillis: Effect.succeed(
              DateTime.toEpochMillis(yesterday),
            ),
            unsafeCurrentTimeMillis: () => DateTime.toEpochMillis(yesterday),
          }),
        ),
      )
      await dev.runPromise(recordDashboardActivity(request, alice))
      await Promise.all([
        dev.runPromise(recordDashboardActivity(request, alice)),
        prod.runPromise(
          recordDashboardActivity(request, normalized).pipe(
            Effect.withClock({
              ...(await Effect.runPromise(Effect.clockWith(Effect.succeed))),
              currentTimeMillis: Effect.succeed(
                DateTime.toEpochMillis(yesterday) + 1,
              ),
              unsafeCurrentTimeMillis: () =>
                DateTime.toEpochMillis(yesterday) + 1,
            }),
          ),
        ),
        two.runPromise(recordDashboardActivity(request, alice)),
      ])
      await two.runPromise(recordDashboardActivity(request, bob))
      await dev.runPromise(
        recordDashboardActivity(request, {
          ...alice,
          properties: {
            ...human,
            humanSession: undefined,
            humanAuthentication: {
              method: "passkey",
              providerUserId: human.userId,
              authenticatedAt: 1,
            },
          },
        }),
      )
      await dev.runPromise(
        recordDashboardActivity(request, {
          ...alice,
          properties: {
            ...human,
            email: "untrusted@example.com",
            humanSession: undefined,
            humanAuthentication: {
              method: "passkey",
              providerUserId: "someone-else",
              authenticatedAt: 1,
            },
          },
        }),
      )
      await dev.runPromise(recordDashboardActivity(request, machine))
      await dev.runPromise(
        recordDashboardActivity(request, {
          ...alice,
          properties: {
            ...human,
            email: "delegated@example.com",
            delegation: {
              id: "d",
              generationId: "g",
              name: "bot",
              expiresAt: 9999999999999,
            },
          },
        }),
      )
      await dev.runPromise(
        recordDashboardActivity(request, {
          ...alice,
          type: "user",
          properties: { userId: "machine", clientId: "ci" },
        }),
      )
      await dev.runPromise(recordDashboardActivity(request, undefined))
      await dev.runPromise(
        recordDashboardActivity(
          new Request("http://localhost/graphql", { method: "POST" }),
          bob,
        ),
      )
      await runtimeFor("333333333333", "internal", "prod").runPromise(
        recordDashboardActivity(request, bob),
      )
      // A new runtime simulates a cold start; deduplication belongs to Loki.
      await runtimeFor("111111111111", "one", "dev").runPromise(
        recordDashboardActivity(request, alice),
      )
      const globalQuery = panelQuery(0, `${prefix}-.*`)
      let results = await query(globalQuery)
      for (let n = 0; n < 30 && results.length < 2; n++) {
        // Time-shifted OTLP fixture data predates Loki's ingester query window.
        // Flush after collector delivery so the historical UTC bucket is queryable.
        expect((await fetch(`${lokiUrl}/flush`, { method: "POST" })).ok).toBe(
          true,
        )
        await Bun.sleep(1000)
        results = await query(globalQuery)
      }
      expect(results.map((r) => Number(r.value[1])).sort()).toEqual([1, 2])
      expect(
        (await query(panelQuery(0, `${prefix}-.*`, "111111111111"))).every(
          (r) => r.value[1] === "1",
        ),
      ).toBe(true)
      expect(
        (await query(panelQuery(0, `${prefix}-.*`, ".*", "prod"))).map(
          (r) => r.value[1],
        ),
      ).toEqual(["1"])
      expect(
        (await query(panelQuery(1, `${prefix}-.*`)))
          .map((r) => Number(r.value[1]))
          .sort(),
      ).toEqual([1, 1, 2])
      const seriesUrl = new URL(`${lokiUrl}/loki/api/v1/series`)
      seriesUrl.searchParams.set(
        "match[]",
        `{service_name="pf-dashboard-activity",pf_project=~"${prefix}-.*"}`,
      )
      const series = await (await fetch(seriesUrl)).text()
      expect(series).not.toContain("identity")
      expect(series).not.toContain("email")
      expect(series).not.toContain("internal")
      const logUrl = new URL(`${lokiUrl}/loki/api/v1/query_range`)
      logUrl.searchParams.set(
        "query",
        `{service_name="pf-dashboard-activity",pf_project=~"${prefix}-.*"}`,
      )
      const exported = await (await fetch(logUrl)).text()
      expect(exported).not.toContain("@")
      expect(exported).not.toContain("machine")
      expect(exported).toContain("identity")
    } finally {
      await Promise.all(runtimes.map((runtime) => runtime.dispose()))
    }
  },
  90000,
)

const scaleTest =
  logsUrl && lokiUrl && process.env["PF_DAU_SCALE"] === "1" ? test : test.skip
scaleTest(
  "30-day dashboard queries handle 3,000 projects without project fan-out",
  async () => {
    // Representative store/query load, not an auth simulation. The preceding test
    // proves signed activity -> real OTLP -> this same store and panel queries.
    const prefix = `scale-${crypto.randomUUID()}`
    const now = DateTime.unsafeNow()
    const day = 86400000
    const end = DateTime.toEpochMillis(now)
    for (let offset = 0; offset < 3000; offset += 50) {
      const streams = Array.from(
        { length: 50 },
        (_, index) => index + offset,
      ).flatMap((project) =>
        ["dev", "prod"].map((environment) => ({
          stream: {
            service_name: "pf-dashboard-activity",
            pf_account_scope: "customer",
            pf_account_id: project % 2 ? "111111111111" : "222222222222",
            pf_account_name: project % 2 ? "CustomerOne" : "CustomerTwo",
            pf_project: `${prefix}-${project}`,
            pf_environment: environment,
          },
          values: Array.from({ length: 30 }, (_, index) => {
            const time = end - (29 - index) * day
            return [
              String(BigInt(time) * 1000000n),
              JSON.stringify({
                identity: `synthetic-hash-${project % 100}`,
                day: DateTime.formatIsoDate(DateTime.unsafeMake(time)),
              }),
            ]
          }),
        })),
      )
      const response = await fetch(`${lokiUrl}/loki/api/v1/push`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ streams }),
      })
      expect(response.status, await response.text()).toBe(204)
    }
    // Historical synthetic chunks must reach the store: Loki queries ingesters
    // only for the recent window. This is local fixture setup, not a rollout step.
    expect((await fetch(`${lokiUrl}/flush`, { method: "POST" })).ok).toBe(true)
    const started = performance.now()
    let global = await query(panelQuery(0, `${prefix}-.*`))
    for (
      let attempt = 0;
      attempt < 60 &&
      (global.length !== 30 ||
        global.some((entry) => entry.value[1] !== "100"));
      attempt++
    ) {
      await Bun.sleep(1000)
      global = await query(panelQuery(0, `${prefix}-.*`))
    }
    expect(global).toHaveLength(30)
    expect(global.every((entry) => entry.value[1] === "100")).toBe(true)
    const projects = await query(panelQuery(1, `${prefix}-.*`))
    expect(projects).toHaveLength(1000)
    expect(projects.every((entry) => entry.value[1] === "1")).toBe(true)
    const selected = await query(
      panelQuery(0, `${prefix}-.*`, "111111111111", "prod"),
    )
    expect(selected).toHaveLength(30)
    expect(selected.every((entry) => entry.value[1] === "50")).toBe(true)
    expect(performance.now() - started).toBeLessThan(60000)
  },
  180000,
)
