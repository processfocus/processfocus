import { object, string } from "valibot"
import { issuerMatchesIgnoringLoopbackPort } from "../src/endpoints/_internal/client-authentication.js"
import { type IssuerClient, hashClientSecret } from "../src/issuer.js"
import { DummyProvider } from "../src/provider/dummy.js"
import { createSubjects } from "../src/subject.js"
import type { TestApp } from "./test-utils.js"
import { createIssuer, createTestAppFromIssuer } from "./test-utils.js"
import { describe, expect, test } from "bun:test"

const subjects = createSubjects({
  user: object({
    userID: string(),
    clientId: string(),
  }),
})

const createClientJwtIssuer = async () => {
  const secretHash = await hashClientSecret("jwt-secret")
  return createTestAppFromIssuer(
    createIssuer({
      subjects,
      clients: [
        {
          id: "jwt-client",
          redirectUris: [],
          secretHash,
        },
      ] satisfies IssuerClient[],
      providers: {
        dummy: DummyProvider({ email: "foo@bar.com" }),
      },
      success: (ctx) =>
        ctx.subject("user", {
          userID: "123",
          clientId: "jwt-client",
        }),
    }),
  )
}

const mintClientJwt = async (
  issuer: TestApp,
  issuerUrl: string,
): Promise<string> => {
  const basic = Buffer.from("jwt-client:jwt-secret").toString("base64")
  const response = await issuer.request(`${issuerUrl}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
    }).toString(),
  })

  expect(response.status).toBe(200)
  const body = (await response.json()) as { access_token: string }
  return body.access_token
}

const requestWithClientJwt = async (
  issuer: TestApp,
  issuerUrl: string,
  clientJwt: string,
): Promise<Response> => {
  return issuer.request(`${issuerUrl}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Bearer ${clientJwt}`,
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: "jwt-client",
    }).toString(),
  })
}

describe("client_jwt issuer matching", () => {
  test("accepts loopback client JWTs when only the port changes", async () => {
    const originalNodeEnv = process.env["NODE_ENV"]
    process.env["NODE_ENV"] = "development"
    const issuer = await createClientJwtIssuer()
    const token = await mintClientJwt(issuer, "http://localhost:3000")

    try {
      const response = await requestWithClientJwt(
        issuer,
        "http://localhost:3001",
        token,
      )

      expect(response.status).toBe(200)
    } finally {
      if (originalNodeEnv === undefined) {
        delete process.env["NODE_ENV"]
      } else {
        process.env["NODE_ENV"] = originalNodeEnv
      }
    }
  })

  test("rejects loopback client JWTs against public hosts", async () => {
    const issuer = await createClientJwtIssuer()
    const token = await mintClientJwt(issuer, "http://localhost:3000")

    const response = await requestWithClientJwt(
      issuer,
      "https://auth.example.com",
      token,
    )

    expect(response.status).toBe(401)
  })
})

describe("issuerMatchesIgnoringLoopbackPort", () => {
  test.each([
    ["http://localhost:3000", "http://localhost:3001", "development", true],
    ["http://[::1]:3000", "http://[::1]:3001", "development", true],
    ["http://localhost:3000", "http://localhost:3001", "", false],
    ["http://localhost:3000", "http://localhost:3001", "test", false],
    ["http://localhost:3000", "http://localhost:3001", "production", false],
    ["http://localhost:3000/auth", "http://localhost:3001/other", "development", false],
    ["http://localhost:3000", "http://127.0.0.1:3001", "development", false],
    ["https://localhost:3000", "http://localhost:3001", "development", false],
    ["http://localhost:3000", "https://auth.example.com", "development", false],
    ["not a url", "http://localhost:3001", "development", false],
  ])("matches %s against %s in %s: %s", (tokenIssuer, requestIssuer, nodeEnv, expected) => {
    expect(issuerMatchesIgnoringLoopbackPort(tokenIssuer, requestIssuer, nodeEnv)).toBe(expected)
  })
})
