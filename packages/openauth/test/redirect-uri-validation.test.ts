import { Effect } from "effect"
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

const baseClients = [
  {
    id: "test-client",
    redirectUris: [
      "https://app.example.com/callback",
      "http://localhost:3000/callback",
    ],
  },
]

describe("redirect URI validation", () => {
  test("malformed URL bypass vulnerability - https:evil.com", async () => {
    const auth = await createTestAppFromIssuer(
      createIssuer({
        subjects,
        clients: baseClients,
        providers: {
          dummy: DummyProvider({ email: "foo@bar.com" }),
        },
        success: (ctx, _value, _req) =>
          ctx.subject("user", {
            userID: "123",
          }),
      }),
    )

    // Test malformed URL that could bypass validation
    const response = await auth.request(
      "/oauth/authorize?redirect_uri=https:evil.com&response_type=code&client_id=test-client&state=test&code_challenge=dummy&code_challenge_method=S256",
    )

    // Should return 400 for invalid redirect URI
    expect(response.status).toBe(400)
    const error = (await response.json()) as {
      error: string
      error_description: string
    }
    expect(error.error).toBe("unauthorized_client")
    expect(error.error_description).toContain("Invalid redirect_uri")
  })

  test("malformed URL bypass vulnerability - //evil.com", async () => {
    const auth = await createTestAppFromIssuer(
      createIssuer({
        subjects,
        clients: baseClients,
        providers: {
          dummy: DummyProvider({ email: "foo@bar.com" }),
        },
        success: (ctx, _value, _req) =>
          ctx.subject("user", {
            userID: "123",
          }),
      }),
    )

    // Test protocol-relative URL that could bypass validation
    const response = await auth.request(
      "/oauth/authorize?redirect_uri=//evil.com&response_type=code&client_id=test-client&state=test&code_challenge=dummy&code_challenge_method=S256",
    )

    // Should return 400 for invalid redirect URI
    expect(response.status).toBe(400)
    const error = (await response.json()) as {
      error: string
      error_description: string
    }
    expect(error.error).toBe("unauthorized_client")
  })

  test("valid same-domain redirect URI allowed", async () => {
    const auth = await createTestAppFromIssuer(
      createIssuer({
        subjects,
        clients: baseClients,
        providers: {
          dummy: DummyProvider({ email: "foo@bar.com" }),
        },
        success: (ctx, _value, _req) =>
          ctx.subject("user", {
            userID: "123",
          }),
      }),
    )

    // Test valid same-domain redirect URI
    const response = await auth.request(
      "/oauth/authorize?redirect_uri=https://app.example.com/callback&response_type=code&client_id=test-client&state=test&code_challenge=dummy&code_challenge_method=S256",
    )

    // Should redirect successfully for valid redirect URI
    expect(response.status).toBe(302)
  })

  test("localhost redirect URI allowed", async () => {
    const auth = await createTestAppFromIssuer(
      createIssuer({
        subjects,
        clients: baseClients,
        providers: {
          dummy: DummyProvider({ email: "foo@bar.com" }),
        },
        success: (ctx, _value, _req) =>
          ctx.subject("user", {
            userID: "123",
          }),
      }),
    )

    // Test localhost redirect URI
    const response = await auth.request(
      "/oauth/authorize?redirect_uri=http://localhost:3000/callback&response_type=code&client_id=test-client&state=test&code_challenge=dummy&code_challenge_method=S256",
    )

    // Should redirect successfully for localhost
    expect(response.status).toBe(302)
  })

  test("custom allow function with strict validation", async () => {
    const auth = await createTestAppFromIssuer(
      createIssuer({
        subjects,
        clients: [
          {
            id: "web-client",
            redirectUris: ["https://app.example.com/callback"],
          },
          {
            id: "mobile-client",
            redirectUris: ["https://admin.example.com/oauth"],
          },
        ],
        providers: {
          dummy: DummyProvider({ email: "foo@bar.com" }),
        },
        allow: (input, _req) =>
          Effect.succeed(
            ({
              "web-client": ["https://app.example.com/callback"],
              "mobile-client": ["https://admin.example.com/oauth"],
            } as Record<string, string[]>)[input.clientID]?.includes(
              input.redirectURI,
            ) ?? false,
          ),
        success: (ctx, _value, _req) =>
          ctx.subject("user", {
            userID: "123",
          }),
      }),
    )

    // Test allowed redirect URI
    let response = await auth.request(
      "/oauth/authorize?redirect_uri=https://app.example.com/callback&response_type=code&client_id=web-client&state=test&code_challenge=dummy&code_challenge_method=S256",
    )
    expect(response.status).toBe(302)

    // Test disallowed redirect URI
    response = await auth.request(
      "/oauth/authorize?redirect_uri=https://evil.com/callback&response_type=code&client_id=web-client&state=test&code_challenge=dummy&code_challenge_method=S256",
    )
    expect(response.status).toBe(400)
    const error = (await response.json()) as {
      error: string
      error_description: string
    }
    expect(error.error).toBe("unauthorized_client")
  })
})
