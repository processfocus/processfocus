import { Effect, Schema } from "effect"
import { createClient } from "@pf/openauth/client"
import { DummyProvider } from "../../openauth/src/provider/dummy.js"
import {
  createIssuer,
  createTestAppFromIssuer,
} from "../../openauth/test/test-utils.js"
import { subjects } from "../src/lib/subjects.js"
import { expect, test } from "bun:test"

// Exercise signed subject transport, not ceremony verification: the issuer
// callback here supplies already-established evidence (or none).
for (const humanSession of [undefined, true] as const) {
  for (const humanAuthentication of [
    undefined,
    {
      providerUserId: "alice-db-id",
      authenticatedAt: 1700000000123,
      method: "passkey" as const,
    },
  ]) {
    test(`signed refresh and CLI scope preserve provenance ${humanSession} and ${humanAuthentication ? "preserve original" : "do not manufacture"} human evidence`, async () => {
      const auth = await createTestAppFromIssuer(
        createIssuer({
          subjects,
          clients: [
            {
              id: "frontend",
              redirectUris: ["https://client.example.com/callback"],
            },
          ],
          providers: { dummy: DummyProvider({ email: "alice@example.com" }) },
          success: (ctx) =>
            ctx.subject("providerUser", {
              userId: "alice-db-id",
              email: "alice@example.com",
              orgUnitId: "/",
              orgUnitPath: "/",
              roles: ["/Employee"],
              ...(humanSession ? { humanSession } : {}),
              ...(humanAuthentication ? { humanAuthentication } : {}),
            }),
          onRefreshScope: ({ currentProperties }) =>
            Effect.succeed({ properties: currentProperties }),
        }),
      )
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
      const exchanged = await client.exchange(
        code,
        "https://client.example.com/callback",
        verifier,
      )
      if (exchanged.err) throw exchanged.err
      let tokens = exchanged.tokens
      for (const scope of [undefined, "role:/Employee", "cli"]) {
        const refreshed = await client.refresh(
          tokens.refresh,
          scope ? { scope } : undefined,
        )
        if (refreshed.err) throw refreshed.err
        expect(refreshed.tokens).toBeDefined()
        tokens = refreshed.tokens!
        const verified = await client.verify(subjects, tokens.access)
        if (verified.err) throw verified.err
        expect(verified.subject.type).toBe("providerUser")
        if (verified.subject.type !== "providerUser")
          throw new Error("Expected provider user")
        expect(verified.subject.properties.humanAuthentication).toEqual(
          humanAuthentication,
        )
        expect(verified.subject.properties.humanSession).toBe(humanSession)
      }
      // Altering a claim without re-signing cannot establish trusted evidence.
      const parts = tokens.access.split(".")
      const payload = Schema.decodeUnknownSync(
        Schema.parseJson(
          Schema.Struct({
            properties: Schema.Record({
              key: Schema.String,
              value: Schema.Unknown,
            }),
          }),
        ),
        { onExcessProperty: "preserve" },
      )(Buffer.from(parts[1]!, "base64url").toString())
      payload.properties.humanAuthentication = {
        providerUserId: "alice-db-id",
        authenticatedAt: Date.now(),
        method: "passkey",
      }
      payload.properties.humanSession = true
      const forged = `${parts[0]}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${parts[2]}`
      expect((await client.verify(subjects, forged)).err).toBeDefined()
    })
  }
}

test("subject schema rejects unsupported methods and invalid timestamps", async () => {
  for (const humanAuthentication of [
    { providerUserId: "alice", authenticatedAt: 123, method: "google" },
    { providerUserId: "alice", authenticatedAt: -1, method: "passkey" },
    { providerUserId: "alice", authenticatedAt: 1.5, method: "passkey" },
  ]) {
    const result = await subjects.providerUser["~standard"].validate({
      userId: "alice",
      email: "alice@example.com",
      orgUnitId: "/",
      orgUnitPath: "/",
      roles: [],
      humanAuthentication,
    })
    expect(result.issues).toBeDefined()
  }
})
