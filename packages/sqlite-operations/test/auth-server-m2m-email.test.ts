import { Effect, Schema } from "effect"
import { createAuthenticationServer } from "@pf/auth-api"
import { subjects } from "@pf/auth-session"
import { createTestApp } from "@pf/openauth"
import { createClient } from "@pf/openauth/client"
import { TestLayer } from "./auth-server.fixture.js"
import { expect, it } from "bun:test"

it("rejects retired email scopes but still issues ordinary machine access", async () => {
  const secretHash = await Bun.password.hash("e2e-secret")
  await Effect.runPromise(
    Effect.gen(function* () {
      const { app, runtime } = yield* createAuthenticationServer({
        clients: [{ id: "e2e-client", redirectUris: [], secretHash }],
      })
      const auth = createTestApp(app, { runtime })
      const issuer = "https://auth.example.com"
      const request = (scope: string) =>
        auth.request(`${issuer}/oauth/token`, {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from("e2e-client:e2e-secret").toString("base64")}`,
          },
          body: new URLSearchParams({
            grant_type: "client_credentials",
            scope,
          }),
        })
      for (const scope of [
        "email:employee%40example.com",
        "email:",
        "role:%2FTester email:%",
      ]) {
        const response = yield* Effect.promise(() => request(scope))
        expect(response.status).toBe(400)
        const body = yield* Effect.promise(() => response.json())
        expect(body).toMatchObject({ error: "invalid_scope" })
        expect(body).not.toHaveProperty("access_token")
      }
      const response = yield* Effect.promise(() => request(""))
      expect(response.status).toBe(200)
      const body = Schema.decodeUnknownSync(
        Schema.Struct({ access_token: Schema.String }),
      )(yield* Effect.promise(() => response.json()))
      const client = createClient({
        issuer,
        clientID: "e2e-client",
        fetch: (url, init) => Promise.resolve(auth.request(url, init)),
      })
      const verified = yield* Effect.promise(() =>
        client.verify(subjects, body.access_token),
      )
      expect(verified).toMatchObject({
        subject: {
          type: "user",
          properties: { clientId: "e2e-client" },
        },
      })
    }).pipe(Effect.provide(TestLayer)),
  )
})
