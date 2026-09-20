import { DateTime, Effect } from "effect"
import { createAuthenticationServer } from "@pf/auth-api"
import * as schema from "@pf/drizzle-sqlite"
import { createTestApp } from "@pf/openauth"
import { createClient } from "@pf/openauth/client"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite"
import { TestLayer } from "./auth-server.fixture.js"
import { describe, expect, it } from "bun:test"

const REDIRECT_URI = "https://test.example.com/callback"

const cookieValue = (setCookie: string | null): string => {
  const value = setCookie?.split(";")[0]
  if (!value) throw new Error("Expected cookie value")
  return value
}

const runGithubLogin = (options: {
  readonly profile?: Record<string, unknown>
  readonly emails?: readonly Record<string, unknown>[]
  readonly profileStatus?: number
  readonly emailStatus?: number
  readonly existingUser?: boolean
}) =>
  Effect.gen(function* () {
    const db = yield* TypedSqliteDrizzle
    const [root] = yield* db
      .insert(schema.orgUnit)
      .values({
        name: "Root Organization",
        orgUnitLevel: "root",
        path: "/",
        parentOrgUnitId: null,
      })
      .returning()
    if (!root) throw new Error("Failed to create root org unit")

    yield* db.insert(schema.oauthProvider).values({
      providerName: "github",
      providerConfig: {
        clientID: "github-client",
        clientSecret: "github-secret",
        scopes: ["read:user", "user:email"],
        inviteOnly: false,
      },
    })

    const subject = String(options.profile?.["id"] ?? "github-subject")
    if (options.existingUser) {
      const now = yield* DateTime.now
      const [user] = yield* db
        .insert(schema.user)
        .values({ provider: "github", sub: subject, lastLoggedIn: now })
        .returning()
      if (!user) throw new Error("Failed to create existing user")
      yield* db.insert(schema.providerUser).values({
        userId: user.id,
        email: "existing@example.com",
        name: "Existing User",
        firstName: "Existing",
        lastName: "User",
        picture: "",
        locale: "en",
        orgUnitId: root.id,
      })
    }

    const { app, runtime } = yield* createAuthenticationServer({
      clients: [{ id: "test-client", redirectUris: [REDIRECT_URI] }],
    })
    const auth = createTestApp(app, { runtime })
    const client = createClient({
      issuer: "https://auth.example.com",
      clientID: "test-client",
      fetch: (input, init) => Promise.resolve(auth.request(input, init)),
    })
    const { url } = yield* Effect.promise(() =>
      client.authorize(REDIRECT_URI, "code", {
        pkce: true,
        provider: "github",
      }),
    )
    const authorizationResponse = yield* Effect.promise(() => auth.request(url))
    const authorizationCookie = cookieValue(
      authorizationResponse.headers.get("set-cookie"),
    )
    const providerResponse = yield* Effect.promise(() =>
      auth.request(authorizationResponse.headers.get("location") ?? "", {
        headers: { cookie: authorizationCookie },
      }),
    )
    const providerCookie = cookieValue(
      providerResponse.headers.get("set-cookie"),
    )
    const githubUrl = new URL(providerResponse.headers.get("location") ?? "")

    const originalFetch = globalThis.fetch
    globalThis.fetch = Object.assign(
      (input: Parameters<typeof globalThis.fetch>[0]) => {
        const requestUrl =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url
        if (requestUrl === "https://github.com/login/oauth/access_token") {
          return Promise.resolve(
            Response.json({ access_token: "github-access-token" }),
          )
        }
        if (requestUrl === "https://api.github.com/user") {
          return Promise.resolve(
            Response.json(options.profile ?? {}, {
              status: options.profileStatus ?? 200,
            }),
          )
        }
        if (requestUrl === "https://api.github.com/user/emails") {
          return Promise.resolve(
            Response.json(options.emails ?? [], {
              status: options.emailStatus ?? 200,
            }),
          )
        }
        return originalFetch(input)
      },
      { preconnect: originalFetch.preconnect },
    )

    const callbackUrl = new URL(
      githubUrl.searchParams.get("redirect_uri") ?? "",
    )
    callbackUrl.searchParams.set("code", "github-code")
    callbackUrl.searchParams.set(
      "state",
      githubUrl.searchParams.get("state") ?? "",
    )
    const callbackResponse = yield* Effect.promise(() =>
      auth.request(callbackUrl, {
        headers: { cookie: `${authorizationCookie}; ${providerCookie}` },
      }),
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          globalThis.fetch = originalFetch
        }),
      ),
    )

    return { callbackResponse, db }
  })

describe("auth-server GitHub verified human identity", () => {
  it("creates a user from an explicitly verified primary email", async () => {
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const { callbackResponse, db } = yield* runGithubLogin({
            profile: { id: 42, login: "octocat", name: "Octo Cat" },
            emails: [
              {
                email: " Octo.Cat@Example.COM ",
                primary: true,
                verified: true,
              },
            ],
          })

          expect(callbackResponse.status).toBe(302)
          const location = new URL(
            callbackResponse.headers.get("location") ?? "",
          )
          expect(location.searchParams.get("code")).not.toBeNull()
          const users = yield* db.select().from(schema.providerUser)
          expect(users).toHaveLength(1)
          expect(users[0]?.email).toBe("octo.cat@example.com")
        }),
        TestLayer,
      ),
    )
  })

  it("rejects an unverified email without creating a user", async () => {
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const { callbackResponse, db } = yield* runGithubLogin({
            profile: { id: 43, login: "unverified" },
            emails: [
              {
                email: "unverified@example.com",
                primary: true,
                verified: false,
              },
            ],
          })
          const location = new URL(
            callbackResponse.headers.get("location") ?? "",
          )
          expect(location.searchParams.get("error")).toBe("access_denied")
          expect(yield* db.select().from(schema.user)).toHaveLength(0)
          expect(yield* db.select().from(schema.providerUser)).toHaveLength(0)
        }),
        TestLayer,
      ),
    )
  })

  it("fails closed when the provider API fails", async () => {
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const { callbackResponse, db } = yield* runGithubLogin({
            profileStatus: 503,
          })
          expect(callbackResponse.status).toBe(500)
          expect(yield* db.select().from(schema.user)).toHaveLength(0)
        }),
        TestLayer,
      ),
    )
  })

  it("signs in an existing user by stable subject without verified email", async () => {
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const { callbackResponse, db } = yield* runGithubLogin({
            profile: { id: 44, login: "existing" },
            emails: [],
            emailStatus: 503,
            existingUser: true,
          })
          const location = new URL(
            callbackResponse.headers.get("location") ?? "",
          )
          expect(location.searchParams.get("code")).not.toBeNull()
          expect(yield* db.select().from(schema.providerUser)).toHaveLength(1)
        }),
        TestLayer,
      ),
    )
  })
})
