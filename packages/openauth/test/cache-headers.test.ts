import { object, string } from "valibot"
import { createClient } from "../src/client.js"
import { hashClientSecret } from "../src/issuer.js"
import { DummyProvider } from "../src/provider/dummy.js"
import { createSubjects } from "../src/subject.js"
import {
  type TestApp,
  createIssuer,
  createTestAppFromIssuer,
} from "./test-utils.js"
import { beforeAll, describe, expect, it } from "bun:test"

const subjects = createSubjects({
  user: object({
    email: string(),
  }),
})

describe("Cache-Control headers", () => {
  let app: TestApp

  const expectNoStoreHeaders = (response: Response) => {
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    expect(response.headers.get("Pragma")).toBe("no-cache")
  }

  const createAuthClient = () =>
    createClient({
      issuer: "https://auth.example.com",
      clientID: "test",
      fetch: (a, b) => Promise.resolve(app.request(a, b)),
    })

  const issueAuthorizationCode = async () => {
    const client = createAuthClient()
    const { challenge, url } = await client.authorize(
      "http://localhost/callback",
      "code",
      { pkce: true },
    )

    let response = await app.request(url)
    response = await app.request(response.headers.get("location")!, {
      headers: {
        cookie: response.headers.get("set-cookie")!,
      },
    })

    const code = new URL(response.headers.get("location")!).searchParams.get(
      "code",
    )

    expect(code).toBeTruthy()

    return {
      challenge,
      code: code!,
    }
  }

  beforeAll(async () => {
    const testSecretHash = await hashClientSecret("test-secret")
    app = await createTestAppFromIssuer(
      createIssuer({
        clients: [
          {
            id: "test-client",
            redirectUris: [
              "http://localhost/callback",
              "http://localhost:3000/callback",
            ],
            secretHash: testSecretHash,
          },
          {
            id: "test",
            redirectUris: ["http://localhost/callback"],
          },
        ],
        providers: {
          dummy: DummyProvider({ email: "test@example.com" }),
        },
        subjects,
        success: (ctx, _value, _req) =>
          ctx.subject("user", {
            email: "test@example.com",
          }),
      }),
    )
  })

  it("should include Cache-Control on JWKS endpoint", async () => {
    const response = await app.request("/.well-known/jwks.json")
    expect(response.headers.get("Cache-Control")).toBe(
      "public, max-age=3600, s-maxage=86400",
    )
    expect(response.status).toBe(200)
  })

  it("should include Cache-Control on OAuth metadata endpoint", async () => {
    const response = await app.request(
      "/.well-known/oauth-authorization-server",
    )
    expect(response.headers.get("Cache-Control")).toBe(
      "public, max-age=3600, s-maxage=86400",
    )
    expect(response.status).toBe(200)
  })

  it("should include no-store headers on token endpoint success", async () => {
    const { challenge, code } = await issueAuthorizationCode()

    const tokenResponse = await app.request("/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: "test",
        redirect_uri: "http://localhost/callback",
        code: code!,
        code_verifier: challenge.verifier!,
      }).toString(),
    })

    expect(tokenResponse.status).toBe(200)
    expectNoStoreHeaders(tokenResponse)
  })

  it("should include no-store headers on refresh token success", async () => {
    const { challenge, code } = await issueAuthorizationCode()

    const exchangeResponse = await app.request("/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: "test",
        redirect_uri: "http://localhost/callback",
        code,
        code_verifier: challenge.verifier!,
      }).toString(),
    })

    expect(exchangeResponse.status).toBe(200)

    const exchanged = (await exchangeResponse.json()) as {
      refresh_token: string
    }

    const refreshResponse = await app.request("/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: "test",
        refresh_token: exchanged.refresh_token,
      }).toString(),
    })

    expect(refreshResponse.status).toBe(200)
    expectNoStoreHeaders(refreshResponse)
  })

  it("should include no-store headers on client credentials success", async () => {
    const basic = btoa("test-client:test-secret")

    const response = await app.request("/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basic}`,
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        provider: "dummy",
        provider_client_id: "myuser",
        provider_client_secret: "mypass",
      }).toString(),
    })

    expect(response.status).toBe(200)
    expectNoStoreHeaders(response)
  })
})
