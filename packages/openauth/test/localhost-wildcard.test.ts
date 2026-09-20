import { object, string } from "valibot"
import { DummyProvider } from "../src/provider/dummy.js"
import { createSubjects } from "../src/subject.js"
import { createIssuer, createTestAppFromIssuer } from "./test-utils.js"
import { describe, expect, test } from "bun:test"

const subjects = createSubjects({
  user: object({
    userID: string(),
  }),
})

describe("localhost wildcard redirect URI validation", () => {
  test("localhost wildcard matches any localhost port", async () => {
    const auth = await createTestAppFromIssuer(
      createIssuer({
        subjects,
        // Register http://localhost without port
        clients: [
          {
            id: "test-client",
            redirectUris: ["http://localhost/api/auth/callback"],
          },
        ],
        providers: {
          dummy: DummyProvider({ email: "foo@bar.com" }),
        },
        success: (ctx, _value, _req) =>
          ctx.subject("user", {
            userID: "123",
          }),
      }),
    )

    // Test various localhost ports
    const ports = [3000, 3001, 3005, 4000, 8080, 9999]
    for (const port of ports) {
      const response = await auth.request(
        `/oauth/authorize?redirect_uri=http://localhost:${port}/api/auth/callback&response_type=code&client_id=test-client&state=test&code_challenge=dummy&code_challenge_method=S256`,
      )
      expect(response.status).toBe(302)
    }
  })

  test("localhost wildcard does not match different paths", async () => {
    const auth = await createTestAppFromIssuer(
      createIssuer({
        subjects,
        clients: [
          {
            id: "test-client",
            redirectUris: ["http://localhost/api/auth/callback"],
          },
        ],
        providers: {
          dummy: DummyProvider({ email: "foo@bar.com" }),
        },
        success: (ctx, _value, _req) =>
          ctx.subject("user", {
            userID: "123",
          }),
      }),
    )

    // Should reject different path
    const response = await auth.request(
      "/oauth/authorize?redirect_uri=http://localhost:3000/different/path&response_type=code&client_id=test-client&state=test&code_challenge=dummy&code_challenge_method=S256",
    )
    expect(response.status).toBe(400)
  })
})
