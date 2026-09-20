import { Effect } from "effect"
import { object, string } from "valibot"
import { createClient } from "../src/client.js"
import { type IssuerClient, hashClientSecret } from "../src/issuer.js"
import { DummyProvider } from "../src/provider/dummy.js"
import { OnRefreshScopeError } from "../src/services/callbacks.js"
import { createSubjects } from "../src/subject.js"
import {
  type IssuerInput,
  type TestApp,
  createIssuer,
  createTestAppFromIssuer,
} from "./test-utils.js"
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test"

const subjects = createSubjects({
  user: object({
    userID: string(),
  }),
})

// Pre-hash secrets for test clients
let serviceSecretHash: string
let otherSecretHash: string

const getIssuerConfig = () => ({
  subjects,
  clients: [
    {
      id: "123",
      redirectUris: [
        "https://client.example.com/callback",
        "https://old.example.com/callback",
        "https://new.example.com/callback",
      ],
    },
    {
      id: "web",
      redirectUris: [
        "https://client.example.com/callback",
        "https://old.example.com/callback",
        "https://new.example.com/callback",
      ],
    },
    {
      id: "service",
      redirectUris: ["https://service.example.com/callback"],
      secretHash: serviceSecretHash,
    },
  ] as IssuerClient[],
  ttl: {
    access: 60,
    refresh: 6000,
    refreshReuse: 60,
    refreshRetention: 6000,
  },
  providers: {
    dummy: DummyProvider({ email: "foo@bar.com" }),
  },
  success: (ctx, _value, _req) =>
    ctx.subject("user", {
      userID: "123",
    }),
})

let issuerConfig: ReturnType<typeof getIssuerConfig>
let auth: TestApp

// Helper to create TestApp from issuer config
const createAuth = (
  config: IssuerInput<
    Record<string, ReturnType<typeof DummyProvider>>,
    typeof subjects,
    unknown
  >,
) => createTestAppFromIssuer(createIssuer(config))

beforeAll(async () => {
  serviceSecretHash = await hashClientSecret("service-secret")
  otherSecretHash = await hashClientSecret("other-secret")
  issuerConfig = getIssuerConfig()
  auth = await createAuth(issuerConfig)
})

const expectNonEmptyString = expect.stringMatching(/.+/)

beforeEach(async () => {
  setSystemTime(new Date("1/1/2024"))
})

afterEach(() => {
  setSystemTime()
})

describe("provider fallback", () => {
  test("redirects to requested provider when it exists", async () => {
    const client = createClient({
      issuer: "https://auth.example.com",
      clientID: "123",
      fetch: (a, b) => Promise.resolve(auth.request(a, b)),
    })
    const { url } = await client.authorize(
      "https://client.example.com/callback",
      "code",
      { pkce: true, provider: "dummy" },
    )

    const response = await auth.request(url)
    expect(response.status).toBe(302)
    const location = response.headers.get("location")!
    expect(location).toBe("/oauth/dummy/authorize")
  })

  test("falls back to dummy provider when requested provider does not exist and dummy is configured", async () => {
    // Create issuer with only a dummy provider
    const dummyOnlyIssuer = await createAuth({
      ...issuerConfig,
      providers: {
        dummy: issuerConfig.providers.dummy,
      },
    })

    const client = createClient({
      issuer: "https://auth.example.com",
      clientID: "123",
      fetch: (a, b) => Promise.resolve(dummyOnlyIssuer.request(a, b)),
    })
    const { url } = await client.authorize(
      "https://client.example.com/callback",
      "code",
      { pkce: true, provider: "google" }, // Request non-existent provider
    )

    const response = await dummyOnlyIssuer.request(url)
    expect(response.status).toBe(302)
    const location = response.headers.get("location")!
    // Should fallback to dummy since google doesn't exist
    expect(location).toBe("/oauth/dummy/authorize")
  })

  test("does not fallback when requested provider does not exist and dummy is not configured", async () => {
    // Create issuer with a provider that is NOT named "dummy"
    const noDummyIssuer = await createAuth({
      ...issuerConfig,
      providers: {
        github: issuerConfig.providers.dummy, // Same provider config, just different name
        gitlab: issuerConfig.providers.dummy,
      },
    })

    const client = createClient({
      issuer: "https://auth.example.com",
      clientID: "123",
      fetch: (a, b) => Promise.resolve(noDummyIssuer.request(a, b)),
    })
    const { url } = await client.authorize(
      "https://client.example.com/callback",
      "code",
      { pkce: true, provider: "google" }, // Request non-existent provider
    )

    const response = await noDummyIssuer.request(url)
    // Should redirect to callback with error since provider doesn't exist and no dummy fallback
    expect(response.status).toBe(302)
    const location = new URL(response.headers.get("location")!)
    expect(location.origin + location.pathname).toBe(
      "https://client.example.com/callback",
    )
    expect(location.searchParams.get("error")).toBe("invalid_request")
    expect(location.searchParams.get("error_description")).toBe(
      "Provider 'google' is not configured",
    )
  })

  test("auto-selects single provider when no provider specified", async () => {
    const client = createClient({
      issuer: "https://auth.example.com",
      clientID: "123",
      fetch: (a, b) => Promise.resolve(auth.request(a, b)),
    })
    // No provider param
    const { url } = await client.authorize(
      "https://client.example.com/callback",
      "code",
      { pkce: true },
    )

    const response = await auth.request(url)
    expect(response.status).toBe(302)
    const location = response.headers.get("location")!
    expect(location).toBe("/oauth/dummy/authorize")
  })
})

describe("implicit flow", () => {
  test("response_type=token is rejected", async () => {
    const url = new URL("https://auth.example.com/oauth/authorize")
    url.searchParams.set("client_id", "123")
    url.searchParams.set("redirect_uri", "https://client.example.com/callback")
    url.searchParams.set("response_type", "token")
    url.searchParams.set("provider", "dummy")

    const response = await auth.request(url.toString())
    expect(response.status).toBe(302)
    const location = new URL(response.headers.get("location")!)
    expect(location.origin + location.pathname).toBe(
      "https://client.example.com/callback",
    )
    expect(location.searchParams.get("error")).toBe("invalid_request")
    expect(location.searchParams.get("error_description")).toBe(
      "Only response_type=code is supported",
    )
  })
})

describe("code flow", () => {
  test("success", async () => {
    const client = createClient({
      issuer: "https://auth.example.com",
      clientID: "123",
      fetch: (a, b) => Promise.resolve(auth.request(a, b)),
    })
    const { challenge, url } = await client.authorize(
      "https://client.example.com/callback",
      "code",
      {
        pkce: true,
      },
    )
    let response = await auth.request(url)
    expect(response.status).toBe(302)
    response = await auth.request(response.headers.get("location")!, {
      headers: {
        cookie: response.headers.get("set-cookie")!,
      },
    })
    expect(response.status).toBe(302)
    const location = new URL(response.headers.get("location")!)
    const code = location.searchParams.get("code")
    expect(code).not.toBeNull()
    const exchanged = await client.exchange(
      code!,
      "https://client.example.com/callback",
      challenge.verifier,
    )
    if (exchanged.err) throw exchanged.err
    const tokens = exchanged.tokens
    expect(tokens).toStrictEqual({
      access: expectNonEmptyString,
      refresh: expectNonEmptyString,
      expiresIn: 60,
      refreshExpiresIn: expect.any(Number),
    })
    const verified = await client.verify(subjects, tokens.access)
    if (verified.err) throw verified.err
    expect(verified.subject).toStrictEqual({
      type: "user",
      properties: {
        userID: "123",
      },
    })
  })
})

describe("audience in authorization code flow", () => {
  test("audience is preserved through code exchange", async () => {
    const client = createClient({
      issuer: "https://auth.example.com",
      clientID: "123",
      audience: "graphql-api",
      fetch: (a, b) => Promise.resolve(auth.request(a, b)),
    })
    const { challenge, url } = await client.authorize(
      "https://client.example.com/callback",
      "code",
      { pkce: true },
    )
    // Verify audience is in the authorization URL
    expect(new URL(url).searchParams.get("audience")).toBe("graphql-api")

    let response = await auth.request(url)
    expect(response.status).toBe(302)
    response = await auth.request(response.headers.get("location")!, {
      headers: {
        cookie: response.headers.get("set-cookie")!,
      },
    })
    expect(response.status).toBe(302)
    const location = new URL(response.headers.get("location")!)
    const code = location.searchParams.get("code")
    expect(code).not.toBeNull()

    const exchanged = await client.exchange(
      code!,
      "https://client.example.com/callback",
      challenge.verifier,
    )
    if (exchanged.err) throw exchanged.err
    const tokens = exchanged.tokens

    // Verify the token has the correct audience
    const verified = await client.verify(subjects, tokens.access, {
      audience: "graphql-api",
    })
    if (verified.err) throw verified.err
    expect(verified.aud).toBe("graphql-api")
    expect(verified.subject).toStrictEqual({
      type: "user",
      properties: {
        userID: "123",
      },
    })
  })

  test("audience is preserved through refresh token exchange", async () => {
    const client = createClient({
      issuer: "https://auth.example.com",
      clientID: "123",
      audience: "graphql-api",
      fetch: (a, b) => Promise.resolve(auth.request(a, b)),
    })
    const { challenge, url } = await client.authorize(
      "https://client.example.com/callback",
      "code",
      { pkce: true },
    )

    let response = await auth.request(url)
    response = await auth.request(response.headers.get("location")!, {
      headers: {
        cookie: response.headers.get("set-cookie")!,
      },
    })
    const location = new URL(response.headers.get("location")!)
    const code = location.searchParams.get("code")
    expect(code).not.toBeNull()

    const exchanged = await client.exchange(
      code!,
      "https://client.example.com/callback",
      challenge.verifier,
    )
    if (exchanged.err) throw exchanged.err

    const refreshed = await client.refresh(exchanged.tokens.refresh)
    if (refreshed.err) throw refreshed.err
    expect(refreshed.tokens).toBeDefined()

    // biome-ignore lint/suspicious/noNonNullAssertedOptionalChain: guarded above
    const verified = await client.verify(subjects, refreshed.tokens?.access!, {
      audience: "graphql-api",
    })
    if (verified.err) throw verified.err
    expect(verified.aud).toBe("graphql-api")
  })

  test("per-call audience override works", async () => {
    const client = createClient({
      issuer: "https://auth.example.com",
      clientID: "123",
      audience: "default-api",
      fetch: (a, b) => Promise.resolve(auth.request(a, b)),
    })
    const { challenge, url } = await client.authorize(
      "https://client.example.com/callback",
      "code",
      { pkce: true, audience: "override-api" },
    )
    // Verify the override audience is in the URL
    expect(new URL(url).searchParams.get("audience")).toBe("override-api")

    let response = await auth.request(url)
    expect(response.status).toBe(302)
    response = await auth.request(response.headers.get("location")!, {
      headers: {
        cookie: response.headers.get("set-cookie")!,
      },
    })
    expect(response.status).toBe(302)
    const location = new URL(response.headers.get("location")!)
    const code = location.searchParams.get("code")

    const exchanged = await client.exchange(
      code!,
      "https://client.example.com/callback",
      challenge.verifier,
    )
    if (exchanged.err) throw exchanged.err

    // Verify the token has the overridden audience
    const verified = await client.verify(subjects, exchanged.tokens.access, {
      audience: "override-api",
    })
    if (verified.err) throw verified.err
    expect(verified.aud).toBe("override-api")
  })
})

describe("error handling (same-request)", () => {
  test("multiple providers without provider param throws after authorization is set -> must redirect with OAuth error", async () => {
    // Two entries pointing to the same dummy provider without provider param
    const multiProviderIssuer = await createAuth({
      ...issuerConfig,
      providers: {
        a: issuerConfig.providers.dummy,
        b: issuerConfig.providers.dummy,
      },
    })

    const client = createClient({
      issuer: "https://auth.example.com",
      clientID: "web",
      fetch: (a, b) => Promise.resolve(multiProviderIssuer.request(a, b)),
    })

    const { url } = await client.authorize(
      "https://client.example.com/callback",
      "code",
    )

    const res = await multiProviderIssuer.request(url)

    // Desired behavior: redirect to redirect_uri with invalid_request error
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get("location")!)
    expect(location.origin + location.pathname).toBe(
      "https://client.example.com/callback",
    )
    expect(location.searchParams.get("error")).toBe("invalid_request")
  })
})

describe("authorization precedence", () => {
  test("request params take precedence over stale cookie per OAuth spec", async () => {
    // 1) Create a stale authorization cookie pointing to old.example.com
    const staleIssuer = await createAuth(issuerConfig)
    const staleClient = createClient({
      issuer: "https://auth.example.com",
      clientID: "web",
      fetch: (a, b) => Promise.resolve(staleIssuer.request(a, b)),
    })
    const { url: staleUrl } = await staleClient.authorize(
      "https://old.example.com/callback",
      "code",
    )
    const staleRes = await staleIssuer.request(staleUrl)
    expect(staleRes.status).toBe(302)
    const staleCookie = staleRes.headers.get("set-cookie")!

    // 2) In a new request with a stale cookie, use different redirect_uri.
    // The error (missing provider param) should redirect to the NEW callback
    // from the current request per OAuth spec, not the old cookie.
    const throwingIssuer = await createAuth({
      ...issuerConfig,
      providers: {
        a: issuerConfig.providers.dummy,
        b: issuerConfig.providers.dummy,
      },
    })
    const freshClient = createClient({
      issuer: "https://auth.example.com",
      clientID: "web",
      fetch: (a, b) => Promise.resolve(throwingIssuer.request(a, b)),
    })
    const { url: freshUrl } = await freshClient.authorize(
      "https://new.example.com/callback",
      "code",
    )
    const res = await throwingIssuer.request(freshUrl, {
      headers: { cookie: staleCookie },
    })

    // Per OAuth spec, redirect_uri from current request takes precedence
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get("location")!)
    expect(location.origin + location.pathname).toBe(
      "https://new.example.com/callback",
    )
    expect(location.searchParams.get("error")).toBe("invalid_request")
  })
})

describe("client credentials flow", () => {
  test("success", async () => {
    const client = createClient({
      issuer: "https://auth.example.com",
      clientID: "service", // Must match the client used for client_credentials grant
      fetch: (a, b) => Promise.resolve(auth.request(a, b)),
    })
    const basic = Buffer.from("service:service-secret").toString("base64")
    const response = await auth.request(
      "https://auth.example.com/oauth/token",
      {
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
      },
    )

    expect(response.status).toBe(200)
    const tokens = (await response.json()) as {
      access_token: string
      expires_in: number
      refresh_token?: string
    }
    expect(tokens).toStrictEqual({
      access_token: expectNonEmptyString,
      expires_in: expect.any(Number),
    })
    const verified = await client.verify(subjects, tokens.access_token)
    expect(verified).toStrictEqual({
      aud: "service",
      subject: {
        type: "user",
        properties: {
          userID: "123",
        },
      },
    })
  })
})

describe("token endpoint content-type validation", () => {
  const tokenUrl = "https://auth.example.com/oauth/token"

  const expectInvalidContentTypeError = async (response) => {
    expect(response.status).toBe(415)
    const body = (await response.json()) as {
      error: string
      error_description: string
    }
    expect(body).toStrictEqual({
      error: "invalid_request",
      error_description:
        "Content-Type must be application/x-www-form-urlencoded",
    })
  }

  test("rejects application/json", async () => {
    const response = await auth.request(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        grant_type: "client_credentials",
      }),
    })

    await expectInvalidContentTypeError(response)
  })

  test("rejects missing content-type header", async () => {
    const response = await auth.request(tokenUrl, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "client_credentials",
      }).toString(),
    })

    await expectInvalidContentTypeError(response)
  })

  test("accepts charset parameter", async () => {
    const basic = Buffer.from("service:service-secret").toString("base64")
    const response = await auth.request(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
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
    const tokens = (await response.json()) as {
      access_token: string
      expires_in: number
      refresh_token?: string
    }
    expect(tokens).toStrictEqual({
      access_token: expectNonEmptyString,
      expires_in: expect.any(Number),
    })
  })

  test("rejects empty content-type value", async () => {
    const response = await auth.request(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
      }).toString(),
    })

    await expectInvalidContentTypeError(response)
  })
})

describe("refresh token", () => {
  let tokens: { access: string; refresh: string }
  let client: ReturnType<typeof createClient>

  const generateTokens = async (issuer: typeof auth) => {
    const { challenge, url } = await client.authorize(
      "https://client.example.com/callback",
      "code",
      {
        pkce: true,
      },
    )
    let response = await issuer.request(url)
    response = await issuer.request(response.headers.get("location")!, {
      headers: {
        cookie: response.headers.get("set-cookie")!,
      },
    })
    const location = new URL(response.headers.get("location")!)
    const code = location.searchParams.get("code")
    const exchanged = await client.exchange(
      code!,
      "https://client.example.com/callback",
      challenge.verifier,
    )
    if (exchanged.err) throw exchanged.err
    return exchanged.tokens
  }

  const createClientAndTokens = async (issuer: typeof auth) => {
    client = createClient({
      issuer: "https://auth.example.com",
      clientID: "123",
      fetch: (a, b) => Promise.resolve(issuer.request(a, b)),
    })
    tokens = await generateTokens(issuer)
  }

  const requestRefreshToken = async (
    refresh_token: string,
    issuer?: typeof auth,
  ) =>
    (issuer ?? auth).request("https://auth.example.com/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: "123",
        ...(refresh_token ? { refresh_token } : {}),
      }).toString(),
    })

  beforeEach(async () => {
    await createClientAndTokens(auth)
  })

  test("success", async () => {
    setSystemTime(Date.now() + 1000 * 60 + 1000)
    const response = await requestRefreshToken(tokens.refresh)
    expect(response.status).toBe(200)
    const refreshed = (await response.json()) as {
      access_token: string
      refresh_token: string
      expires_in: number
      refresh_expires_in: number
    }
    expect(refreshed).toStrictEqual({
      access_token: expectNonEmptyString,
      refresh_token: expectNonEmptyString,
      expires_in: expect.any(Number),
      refresh_expires_in: expect.any(Number),
    })
    expect(refreshed.access_token).not.toEqual(tokens.access)
    expect(refreshed.refresh_token).not.toEqual(tokens.refresh)

    const verified = await client.verify(subjects, refreshed.access_token)
    expect(verified).toStrictEqual({
      aud: "123",
      subject: {
        type: "user",
        properties: {
          userID: "123",
        },
      },
    })
  })

  test("success with valid access token", async () => {
    // have to increment the time so new access token claims are different (i.e. exp)
    setSystemTime(Date.now() + 1000)
    const response = await requestRefreshToken(tokens.refresh)
    expect(response.status).toBe(200)
    const refreshed = (await response.json()) as {
      access_token: string
      refresh_token: string
      expires_in: number
      refresh_expires_in: number
    }
    expect(refreshed).toStrictEqual({
      access_token: expectNonEmptyString,
      refresh_token: expectNonEmptyString,
      expires_in: expect.any(Number),
      refresh_expires_in: expect.any(Number),
    })

    expect(refreshed.access_token).not.toEqual(tokens.access)
    expect(refreshed.refresh_token).not.toEqual(tokens.refresh)

    const verified = await client.verify(subjects, refreshed.access_token)
    expect(verified).toStrictEqual({
      aud: "123",
      subject: {
        type: "user",
        properties: {
          userID: "123",
        },
      },
    })
  })

  test("multiple active tokens", async () => {
    const tokens2 = await generateTokens(auth)

    let response = await requestRefreshToken(tokens.refresh)
    expect(response.status).toBe(200)

    response = await requestRefreshToken(tokens2.refresh)
    expect(response.status).toBe(200)
  })

  test("failure with reuse interval disabled", async () => {
    const issuerWithoutReuse = await createAuth({
      ...issuerConfig,
      ttl: {
        ...issuerConfig.ttl,
        refreshReuse: 0,
        refreshRetention: 0,
      },
    })
    await createClientAndTokens(issuerWithoutReuse)
    let response = await requestRefreshToken(tokens.refresh, issuerWithoutReuse)
    expect(response.status).toBe(200)

    response = await requestRefreshToken(tokens.refresh, issuerWithoutReuse)
    expect(response.status).toBe(400)
    const reused = (await response.json()) as { error: string }
    expect(reused.error).toBe("invalid_grant")
  })

  test("success with reuse interval enabled", async () => {
    let response = await requestRefreshToken(tokens.refresh)
    expect(response.status).toBe(200)
    const refreshed = (await response.json()) as {
      access_token: string
      refresh_token: string
      expires_in: number
      refresh_expires_in: number
    }
    const [, refreshedAccessPayload] = refreshed.access_token.split(".")

    setSystemTime(Date.now() + 1000 * 30)

    response = await requestRefreshToken(tokens.refresh)
    expect(response.status).toBe(200)
    const reused = (await response.json()) as {
      access_token: string
      refresh_token: string
      expires_in: number
      refresh_expires_in: number
    }
    const [, reusedAccessPayload] = reused.access_token.split(".")
    expect(refreshed.refresh_token).toEqual(reused.refresh_token)
    /**
     * Access token signature is different every time for ES256 alg,
     * but the payload should be the same.
     */
    expect(refreshedAccessPayload).toEqual(reusedAccessPayload)
  })

  test("reusing an older token does not resurrect an already-used next token", async () => {
    let response = await requestRefreshToken(tokens.refresh)
    expect(response.status).toBe(200)
    const refreshed = (await response.json()) as {
      access_token: string
      refresh_token: string
      expires_in: number
      refresh_expires_in: number
    }

    response = await requestRefreshToken(refreshed.refresh_token)
    expect(response.status).toBe(200)

    setSystemTime(Date.now() + 1000 * 30)

    response = await requestRefreshToken(tokens.refresh)
    expect(response.status).toBe(200)

    setSystemTime(Date.now() + 1000 * 31)

    response = await requestRefreshToken(refreshed.refresh_token)
    expect(response.status).toBe(400)
    const reused = (await response.json()) as { error: string }
    expect(reused.error).toBe("invalid_grant")
  })

  test("invalidated with reuse detection", async () => {
    let response = await requestRefreshToken(tokens.refresh)
    expect(response.status).toBe(200)

    setSystemTime(Date.now() + 1000 * 60 + 1000)

    response = await requestRefreshToken(tokens.refresh)
    expect(response.status).toBe(400)
  })

  test("onRefreshScope can override access token TTL", async () => {
    // Create an issuer with onRefreshScope that returns accessTokenTtl override
    // success callback must include userId in properties (refresh handler requires it for scope)
    const scopeIssuer = await createAuth({
      ...issuerConfig,
      success: (ctx, _value, _req) =>
        ctx.subject("user", {
          userID: "123",
          userId: "test-user",
        }),
      onRefreshScope: ({ scope, currentProperties }) => {
        if (scope === "cli") {
          return Effect.succeed({
            properties: currentProperties,
            accessTokenTtl: 120,
          })
        }
        return Effect.succeed({ properties: currentProperties })
      },
    })

    // Generate tokens with the scope issuer
    const scopeClient = createClient({
      issuer: "https://auth.example.com",
      clientID: "123",
      fetch: (a, b) => Promise.resolve(scopeIssuer.request(a, b)),
    })
    const { challenge, url } = await scopeClient.authorize(
      "https://client.example.com/callback",
      "code",
      { pkce: true },
    )
    let response = await scopeIssuer.request(url)
    response = await scopeIssuer.request(response.headers.get("location")!, {
      headers: { cookie: response.headers.get("set-cookie")! },
    })
    const location = new URL(response.headers.get("location")!)
    const code = location.searchParams.get("code")
    const exchanged = await scopeClient.exchange(
      code!,
      "https://client.example.com/callback",
      challenge.verifier,
    )
    if (exchanged.err) throw exchanged.err
    const scopeTokens = exchanged.tokens

    // Refresh with scope=cli to get overridden TTL
    setSystemTime(Date.now() + 1000)
    const refreshResponse = await scopeIssuer.request(
      "https://auth.example.com/oauth/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: "123",
          refresh_token: scopeTokens.refresh,
          scope: "cli",
        }).toString(),
      },
    )
    expect(refreshResponse.status).toBe(200)
    const refreshed = (await refreshResponse.json()) as {
      access_token: string
      refresh_token: string
      expires_in: number
    }
    // Default TTL is 60, override should give ~120
    expect(refreshed.expires_in).toBeGreaterThan(60)
    expect(refreshed.expires_in).toBeLessThanOrEqual(120)
  })

  test("onRefreshScope rejects cli scope from non-permitted client", async () => {
    // Create an issuer where onRefreshScope only allows cli scope for client "allowed"
    const restrictedIssuer = await createAuth({
      ...issuerConfig,
      success: (ctx, _value, _req) =>
        ctx.subject("user", {
          userID: "123",
          userId: "test-user",
        }),
      onRefreshScope: ({ clientId, scope, currentProperties }) => {
        if (scope === "cli") {
          if (clientId !== "allowed") {
            return Effect.fail(
              new OnRefreshScopeError({
                message: `cli scope not permitted for client ${clientId}`,
              }),
            )
          }
          return Effect.succeed({ properties: currentProperties, accessTokenTtl: 120 })
        }
        return Effect.succeed({ properties: currentProperties })
      },
    })

    // Client "123" is not the permitted "allowed" client
    const restrictedClient = createClient({
      issuer: "https://auth.example.com",
      clientID: "123",
      fetch: (a, b) => Promise.resolve(restrictedIssuer.request(a, b)),
    })
    const { challenge, url } = await restrictedClient.authorize(
      "https://client.example.com/callback",
      "code",
      { pkce: true },
    )
    let response = await restrictedIssuer.request(url)
    response = await restrictedIssuer.request(response.headers.get("location")!, {
      headers: { cookie: response.headers.get("set-cookie")! },
    })
    const location = new URL(response.headers.get("location")!)
    const code = location.searchParams.get("code")
    const exchanged = await restrictedClient.exchange(
      code!,
      "https://client.example.com/callback",
      challenge.verifier,
    )
    if (exchanged.err) throw exchanged.err

    // Refresh with scope=cli from client "123" — should be rejected
    setSystemTime(Date.now() + 1000)
    const refreshResponse = await restrictedIssuer.request(
      "https://auth.example.com/oauth/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: "123",
          refresh_token: exchanged.tokens.refresh,
          scope: "cli",
        }).toString(),
      },
    )
    expect(refreshResponse.status).toBe(400)
    const body = (await refreshResponse.json()) as { error: string }
    expect(body.error).toBe("invalid_scope")
  })

  test("expired failure", async () => {
    setSystemTime(Date.now() + 1000 * 6000 + 1000)
    const response = await requestRefreshToken(tokens.refresh)
    expect(response.status).toBe(400)
    const reused = (await response.json()) as { error: string }
    expect(reused.error).toBe("invalid_grant")
  })

  test("missing failure", async () => {
    const response = await requestRefreshToken("")
    expect(response.status).toBe(400)
    const reused = (await response.json()) as { error: string }
    expect(reused.error).toBe("invalid_request")
  })
})

describe("user info", () => {
  let tokens: { access: string; refresh: string }
  let client: ReturnType<typeof createClient>

  const generateTokens = async (issuer: typeof auth) => {
    const { challenge, url } = await client.authorize(
      "https://client.example.com/callback",
      "code",
      { pkce: true },
    )
    let response = await issuer.request(url)
    response = await issuer.request(response.headers.get("location")!, {
      headers: {
        cookie: response.headers.get("set-cookie")!,
      },
    })
    const location = new URL(response.headers.get("location")!)
    const code = location.searchParams.get("code")
    const exchanged = await client.exchange(
      code!,
      "https://client.example.com/callback",
      challenge.verifier,
    )
    if (exchanged.err) throw exchanged.err
    return exchanged.tokens
  }

  const createClientAndTokens = async (issuer: typeof auth) => {
    client = createClient({
      issuer: "https://auth.example.com",
      clientID: "123",
      fetch: (a, b) => Promise.resolve(issuer.request(a, b)),
    })
    tokens = await generateTokens(issuer)
  }

  beforeEach(async () => {
    await createClientAndTokens(auth)
  })

  test("success", async () => {
    const response = await auth.request(
      "https://auth.example.com/oauth/userinfo",
      {
        headers: { Authorization: `Bearer ${tokens.access}` },
      },
    )

    const userinfo = await response.json()

    expect(userinfo).toStrictEqual({ userID: "123" })
  })
})

describe("confidential client - authorization_code flow", () => {
  test("success with Basic auth", async () => {
    const client = createClient({
      issuer: "https://auth.example.com",
      clientID: "service",
      clientSecret: "service-secret",
      fetch: (a, b) => Promise.resolve(auth.request(a, b)),
    })
    const { challenge, url } = await client.authorize(
      "https://service.example.com/callback",
      "code",
      { pkce: false },
    )
    let response = await auth.request(url)
    expect(response.status).toBe(302)
    response = await auth.request(response.headers.get("location")!, {
      headers: {
        cookie: response.headers.get("set-cookie")!,
      },
    })
    expect(response.status).toBe(302)
    const location = new URL(response.headers.get("location")!)
    const code = location.searchParams.get("code")
    expect(code).not.toBeNull()
    const exchanged = await client.exchange(
      code!,
      "https://service.example.com/callback",
      challenge.verifier,
    )
    if (exchanged.err) throw exchanged.err
    const tokens = exchanged.tokens
    expect(tokens).toStrictEqual({
      access: expectNonEmptyString,
      refresh: expectNonEmptyString,
      expiresIn: 60,
      refreshExpiresIn: expect.any(Number),
    })
    const verified = await client.verify(subjects, tokens.access)
    if (verified.err) throw verified.err
    expect(verified.subject).toStrictEqual({
      type: "user",
      properties: {
        userID: "123",
      },
    })
  })

  test("fails without client secret", async () => {
    // First get an authorization code using a valid flow
    const client = createClient({
      issuer: "https://auth.example.com",
      clientID: "service",
      clientSecret: "service-secret",
      fetch: (a, b) => Promise.resolve(auth.request(a, b)),
    })
    const { url } = await client.authorize(
      "https://service.example.com/callback",
      "code",
      { pkce: false },
    )
    let response = await auth.request(url)
    response = await auth.request(response.headers.get("location")!, {
      headers: {
        cookie: response.headers.get("set-cookie")!,
      },
    })
    const location = new URL(response.headers.get("location")!)
    const code = location.searchParams.get("code")

    // Try to exchange without providing the secret (public client style)
    const tokenResponse = await auth.request(
      "https://auth.example.com/oauth/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code!,
          redirect_uri: "https://service.example.com/callback",
          client_id: "service",
        }).toString(),
      },
    )
    expect(tokenResponse.status).toBe(401)
    const error = (await tokenResponse.json()) as {
      error: string
      error_description: string
    }
    expect(error.error).toBe("invalid_client")
    expect(error.error_description).toBe("Client authentication is required")
  })

  test("fails with wrong client secret", async () => {
    const client = createClient({
      issuer: "https://auth.example.com",
      clientID: "service",
      clientSecret: "service-secret",
      fetch: (a, b) => Promise.resolve(auth.request(a, b)),
    })
    const { url } = await client.authorize(
      "https://service.example.com/callback",
      "code",
      { pkce: false },
    )
    let response = await auth.request(url)
    response = await auth.request(response.headers.get("location")!, {
      headers: {
        cookie: response.headers.get("set-cookie")!,
      },
    })
    const location = new URL(response.headers.get("location")!)
    const code = location.searchParams.get("code")

    // Try to exchange with wrong secret
    const wrongBasic = Buffer.from("service:wrong-secret").toString("base64")
    const tokenResponse = await auth.request(
      "https://auth.example.com/oauth/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${wrongBasic}`,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code!,
          redirect_uri: "https://service.example.com/callback",
        }).toString(),
      },
    )
    expect(tokenResponse.status).toBe(401)
    const error = (await tokenResponse.json()) as {
      error: string
      error_description: string
    }
    expect(error.error).toBe("invalid_client")
    expect(error.error_description).toBe("Invalid client credentials")
  })
})

describe("confidential client - refresh_token flow", () => {
  let tokens: { access: string; refresh: string }
  let client: ReturnType<typeof createClient>

  const generateTokens = async () => {
    const { challenge, url } = await client.authorize(
      "https://service.example.com/callback",
      "code",
      { pkce: false },
    )
    let response = await auth.request(url)
    response = await auth.request(response.headers.get("location")!, {
      headers: {
        cookie: response.headers.get("set-cookie")!,
      },
    })
    const location = new URL(response.headers.get("location")!)
    const code = location.searchParams.get("code")
    const exchanged = await client.exchange(
      code!,
      "https://service.example.com/callback",
      challenge.verifier,
    )
    if (exchanged.err) throw exchanged.err
    return exchanged.tokens
  }

  beforeEach(async () => {
    client = createClient({
      issuer: "https://auth.example.com",
      clientID: "service",
      clientSecret: "service-secret",
      fetch: (a, b) => Promise.resolve(auth.request(a, b)),
    })
    tokens = await generateTokens()
  })

  test("success with Basic auth", async () => {
    setSystemTime(Date.now() + 1000 * 60 + 1000)
    const refreshed = await client.refresh(tokens.refresh)
    expect(refreshed.err).toBe(false)
    if (refreshed.err) throw refreshed.err
    expect(refreshed.tokens).toBeDefined()
    expect(refreshed.tokens?.access).not.toEqual(tokens.access)
    expect(refreshed.tokens?.refresh).not.toEqual(tokens.refresh)

    // biome-ignore lint/suspicious/noNonNullAssertedOptionalChain: we have verified this exists
    const verified = await client.verify(subjects, refreshed.tokens?.access!)
    if (verified.err) throw verified.err
    expect(verified.subject).toStrictEqual({
      type: "user",
      properties: {
        userID: "123",
      },
    })
  })

  test("fails without client secret", async () => {
    // Try to refresh without providing the secret
    const tokenResponse = await auth.request(
      "https://auth.example.com/oauth/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: tokens.refresh,
          client_id: "service",
        }).toString(),
      },
    )
    expect(tokenResponse.status).toBe(401)
    const error = (await tokenResponse.json()) as {
      error: string
      error_description: string
    }
    expect(error.error).toBe("invalid_client")
    expect(error.error_description).toBe("Client authentication is required")
  })

  test("fails with wrong client secret", async () => {
    const wrongBasic = Buffer.from("service:wrong-secret").toString("base64")
    const tokenResponse = await auth.request(
      "https://auth.example.com/oauth/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${wrongBasic}`,
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: tokens.refresh,
        }).toString(),
      },
    )
    expect(tokenResponse.status).toBe(401)
    const error = (await tokenResponse.json()) as {
      error: string
      error_description: string
    }
    expect(error.error).toBe("invalid_client")
    expect(error.error_description).toBe("Invalid client credentials")
  })

  test("fails when different client tries to use refresh token", async () => {
    // Use the same issuer (auth) but authenticate as a different client
    // First, add "other-service" to the base config and recreate the test setup
    const issuerWithBothClients = await createAuth({
      ...issuerConfig,
      clients: [
        ...issuerConfig.clients,
        {
          id: "other-service",
          redirectUris: ["https://other.example.com/callback"],
          secretHash: otherSecretHash,
        },
      ],
    })

    // Create client for "service" and generate tokens with this issuer
    const serviceClient = createClient({
      issuer: "https://auth.example.com",
      clientID: "service",
      clientSecret: "service-secret",
      fetch: (a, b) => Promise.resolve(issuerWithBothClients.request(a, b)),
    })

    // Generate tokens as "service" client
    const challenge = await serviceClient.pkce(
      "https://service.example.com/callback",
    )
    let response = await issuerWithBothClients.request(challenge[1]!)
    response = await issuerWithBothClients.request(
      response.headers.get("location")!,
      {
        headers: {
          cookie: response.headers.get("set-cookie")!,
        },
      },
    )
    const location = new URL(response.headers.get("location")!)
    const code = location.searchParams.get("code")
    const exchanged = await serviceClient.exchange(
      code!,
      "https://service.example.com/callback",
      challenge[0],
    )
    if (exchanged.err) throw exchanged.err
    const serviceTokens = exchanged.tokens

    // Now try to use those tokens with "other-service" client
    const otherBasic = Buffer.from("other-service:other-secret").toString(
      "base64",
    )
    const tokenResponse = await issuerWithBothClients.request(
      "https://auth.example.com/oauth/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${otherBasic}`,
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: serviceTokens.refresh,
        }).toString(),
      },
    )
    expect(tokenResponse.status).toBe(403)
    const error = (await tokenResponse.json()) as {
      error: string
      error_description: string
    }
    expect(error.error).toBe("unauthorized_client")
  })
})

describe("client merging from OPENAUTH_CLIENTS env var", () => {
  const originalEnv = process.env["OPENAUTH_CLIENTS"]

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env["OPENAUTH_CLIENTS"]
    } else {
      process.env["OPENAUTH_CLIENTS"] = originalEnv
    }
  })

  test("explicit clients take precedence over env var clients with same ID", async () => {
    // Set up env var with a client that has the same ID as an explicit client
    process.env["OPENAUTH_CLIENTS"] = JSON.stringify([
      {
        id: "123",
        redirectUris: ["https://env-var.example.com/callback"],
      },
    ])

    // Create issuer with explicit client "123"
    const testIssuer = await createAuth({
      ...issuerConfig,
      clients: [
        {
          id: "123",
          redirectUris: ["https://explicit.example.com/callback"],
        },
      ],
    })

    // The explicit client's redirect URI should be used, not the env var's
    const client = createClient({
      issuer: "https://auth.example.com",
      clientID: "123",
      fetch: (a, b) => Promise.resolve(testIssuer.request(a, b)),
    })

    // This should work (explicit client's redirect URI)
    const { url } = await client.authorize(
      "https://explicit.example.com/callback",
      "code",
      { pkce: true },
    )
    const response = await testIssuer.request(url)
    expect(response.status).toBe(302)
    const location = response.headers.get("location")
    expect(location).toBe("/oauth/dummy/authorize")
  })

  test("env var clients with same ID as explicit clients are ignored", async () => {
    // Set up env var with a client that has the same ID as an explicit client
    process.env["OPENAUTH_CLIENTS"] = JSON.stringify([
      {
        id: "123",
        redirectUris: ["https://env-var.example.com/callback"],
      },
    ])

    // Create issuer with explicit client "123"
    const testIssuer = await createAuth({
      ...issuerConfig,
      clients: [
        {
          id: "123",
          redirectUris: ["https://explicit.example.com/callback"],
        },
      ],
    })

    // The env var's redirect URI should NOT be accepted
    const client = createClient({
      issuer: "https://auth.example.com",
      clientID: "123",
      fetch: (a, b) => Promise.resolve(testIssuer.request(a, b)),
    })

    const { url } = await client.authorize(
      "https://env-var.example.com/callback",
      "code",
      { pkce: true },
    )
    const response = await testIssuer.request(url)
    // Returns 400 because the redirect_uri is invalid (can't redirect to untrusted URI)
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: string }
    expect(body.error).toBe("unauthorized_client")
  })

  test("env var clients are added when no explicit client has same ID", async () => {
    // Set up env var with a new client ID
    process.env["OPENAUTH_CLIENTS"] = JSON.stringify([
      {
        id: "env-only-client",
        redirectUris: ["https://env-only.example.com/callback"],
      },
    ])

    // Create issuer with a different explicit client
    const testIssuer = await createAuth({
      ...issuerConfig,
      clients: [
        {
          id: "123",
          redirectUris: ["https://explicit.example.com/callback"],
        },
      ],
    })

    // The env var client should be available
    const client = createClient({
      issuer: "https://auth.example.com",
      clientID: "env-only-client",
      fetch: (a, b) => Promise.resolve(testIssuer.request(a, b)),
    })

    const { url } = await client.authorize(
      "https://env-only.example.com/callback",
      "code",
      { pkce: true },
    )
    const response = await testIssuer.request(url)
    expect(response.status).toBe(302)
    const location = response.headers.get("location")
    expect(location).toBe("/oauth/dummy/authorize")
  })

  test("env var clients work when no explicit clients provided", async () => {
    // Set up env var with clients
    process.env["OPENAUTH_CLIENTS"] = JSON.stringify([
      {
        id: "env-client",
        redirectUris: ["https://env.example.com/callback"],
      },
    ])

    // Create issuer with no explicit clients
    const testIssuer = await createAuth({
      ...issuerConfig,
      clients: [],
    })

    const client = createClient({
      issuer: "https://auth.example.com",
      clientID: "env-client",
      fetch: (a, b) => Promise.resolve(testIssuer.request(a, b)),
    })

    const { url } = await client.authorize(
      "https://env.example.com/callback",
      "code",
      { pkce: true },
    )
    const response = await testIssuer.request(url)
    expect(response.status).toBe(302)
    const location = response.headers.get("location")
    expect(location).toBe("/oauth/dummy/authorize")
  })

  test("env var client audience is used for client credentials tokens", async () => {
    process.env["OPENAUTH_CLIENTS"] = JSON.stringify([
      {
        id: "env-service",
        redirectUris: [],
        tokenEndpointAuthMethod: "client_secret_basic",
        secret: "env-service-secret",
        audience: "graphql-api",
      },
    ])

    const testIssuer = await createAuth({
      ...issuerConfig,
      clients: [],
    })
    const client = createClient({
      issuer: "https://auth.example.com",
      clientID: "env-service",
      fetch: (a, b) => Promise.resolve(testIssuer.request(a, b)),
    })
    const basic = Buffer.from("env-service:env-service-secret").toString(
      "base64",
    )
    const response = await testIssuer.request(
      "https://auth.example.com/oauth/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${basic}`,
        },
        body: new URLSearchParams({
          grant_type: "client_credentials",
        }).toString(),
      },
    )

    expect(response.status).toBe(200)
    const tokens = (await response.json()) as {
      access_token: string
      expires_in: number
    }
    const verified = await client.verify(subjects, tokens.access_token, {
      audience: "graphql-api",
    })

    expect(verified).toStrictEqual({
      aud: "graphql-api",
      subject: {
        type: "user",
        properties: {
          userID: "123",
        },
      },
    })
  })
})

describe("logout", () => {
  let tokens: { access: string; refresh: string }
  let client: ReturnType<typeof createClient>

  const generateTokens = async (issuer: typeof auth) => {
    const { challenge, url } = await client.authorize(
      "https://client.example.com/callback",
      "code",
      { pkce: true },
    )
    let response = await issuer.request(url)
    response = await issuer.request(response.headers.get("location")!, {
      headers: {
        cookie: response.headers.get("set-cookie")!,
      },
    })
    const location = new URL(response.headers.get("location")!)
    const code = location.searchParams.get("code")
    const exchanged = await client.exchange(
      code!,
      "https://client.example.com/callback",
      challenge.verifier,
    )
    if (exchanged.err) throw exchanged.err
    return exchanged.tokens
  }

  const createClientAndTokens = async (issuer: typeof auth) => {
    client = createClient({
      issuer: "https://auth.example.com",
      clientID: "123",
      fetch: (a, b) => Promise.resolve(issuer.request(a, b)),
    })
    tokens = await generateTokens(issuer)
  }

  beforeEach(async () => {
    await createClientAndTokens(auth)
  })

  test("invalidates refresh token", async () => {
    // First verify refresh token works
    let response = await auth.request("https://auth.example.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh,
        client_id: "123",
      }).toString(),
    })
    expect(response.status).toBe(200)

    // Logout
    response = await auth.request("https://auth.example.com/oauth/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: tokens.refresh,
      }).toString(),
    })
    expect(response.status).toBe(200)
    const logoutResult = (await response.json()) as { success: boolean }
    expect(logoutResult).toStrictEqual({ success: true })

    // Verify refresh token no longer works
    response = await auth.request("https://auth.example.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh,
        client_id: "123",
      }).toString(),
    })
    expect(response.status).toBe(400)
  })

  test("returns error for missing token", async () => {
    const response = await auth.request(
      "https://auth.example.com/oauth/revoke",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "",
      },
    )
    expect(response.status).toBe(400)
    const json = (await response.json()) as { error: string }
    expect(json.error).toBe("invalid_request")
  })

  test("client logout method works", async () => {
    // Call logout via client method
    const result = await client.logout(tokens.refresh)
    expect(result).toStrictEqual({ success: true })

    // Verify refresh token no longer works
    const response = await auth.request(
      "https://auth.example.com/oauth/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: tokens.refresh,
          client_id: "123",
        }).toString(),
      },
    )
    expect(response.status).toBe(400)
  })

  test("returns success for malformed token without colon (RFC 7009)", async () => {
    // RFC 7009 Section 2.2: return 200 OK even for invalid tokens
    const response = await auth.request(
      "https://auth.example.com/oauth/revoke",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: "malformed-token-without-colon",
        }).toString(),
      },
    )
    expect(response.status).toBe(200)
    const json = (await response.json()) as { success: boolean }
    expect(json).toStrictEqual({ success: true })
  })

  test("returns success for token with empty subject or token part (RFC 7009)", async () => {
    // RFC 7009 Section 2.2: return 200 OK even for invalid tokens
    // Token format is "subject:token", so ":token" has empty subject
    let response = await auth.request("https://auth.example.com/oauth/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: ":token-part-only",
      }).toString(),
    })
    expect(response.status).toBe(200)
    let json = (await response.json()) as { success: boolean }
    expect(json).toStrictEqual({ success: true })

    // "subject:" has empty token part
    response = await auth.request("https://auth.example.com/oauth/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: "subject-only:",
      }).toString(),
    })
    expect(response.status).toBe(200)
    json = (await response.json()) as { success: boolean }
    expect(json).toStrictEqual({ success: true })
  })
})

describe("OAuth provider callback URL construction", () => {
  test("redirect_uri includes port from host header", async () => {
    // Import Oauth2Provider for this test
    const { Oauth2Provider } = await import("../src/provider/oauth2.js")

    // Create an issuer with an OAuth2 provider that redirects to an external auth server
    const oauthIssuer = await createAuth({
      ...issuerConfig,
      providers: {
        oauth2test: Oauth2Provider({
          clientID: "test-client",
          clientSecret: "test-secret",
          endpoint: {
            authorization: "https://external-auth.example.com/authorize",
            token: "https://external-auth.example.com/token",
          },
          scopes: ["openid", "email"],
        }),
      },
    })

    // Make a request to the provider's authorize endpoint with a host header that includes a port
    // Use http:// to test port preservation (test utility sets x-forwarded-proto from URL scheme)
    const response = await oauthIssuer.request(
      "http://localhost:4020/oauth/oauth2test/authorize",
      {
        headers: {
          host: "localhost:4020",
        },
      },
    )

    expect(response.status).toBe(302)
    const location = response.headers.get("location")!
    const redirectUrl = new URL(location)

    // The redirect_uri parameter should include the port from the host header
    const redirectUri = redirectUrl.searchParams.get("redirect_uri")
    expect(redirectUri).toBe("http://localhost:4020/oauth/oauth2test/callback")
  })

  test("redirect_uri uses https when x-forwarded-proto is https", async () => {
    const { Oauth2Provider } = await import("../src/provider/oauth2.js")

    const oauthIssuer = await createAuth({
      ...issuerConfig,
      providers: {
        oauth2test: Oauth2Provider({
          clientID: "test-client",
          clientSecret: "test-secret",
          endpoint: {
            authorization: "https://external-auth.example.com/authorize",
            token: "https://external-auth.example.com/token",
          },
          scopes: ["openid", "email"],
        }),
      },
    })

    const response = await oauthIssuer.request(
      "https://auth.example.com/oauth/oauth2test/authorize",
      {
        headers: {
          host: "auth.example.com",
          "x-forwarded-proto": "https",
        },
      },
    )

    expect(response.status).toBe(302)
    const location = response.headers.get("location")!
    const redirectUrl = new URL(location)

    const redirectUri = redirectUrl.searchParams.get("redirect_uri")
    expect(redirectUri).toBe("https://auth.example.com/oauth/oauth2test/callback")
  })

  test("redirect_uri defaults to http://localhost when no host header", async () => {
    const { Oauth2Provider } = await import("../src/provider/oauth2.js")

    const oauthIssuer = await createAuth({
      ...issuerConfig,
      providers: {
        oauth2test: Oauth2Provider({
          clientID: "test-client",
          clientSecret: "test-secret",
          endpoint: {
            authorization: "https://external-auth.example.com/authorize",
            token: "https://external-auth.example.com/token",
          },
          scopes: ["openid", "email"],
        }),
      },
    })

    // Make request without host header
    const response = await oauthIssuer.request(
      "/oauth/oauth2test/authorize",
      {},
    )

    expect(response.status).toBe(302)
    const location = response.headers.get("location")!
    const redirectUrl = new URL(location)

    const redirectUri = redirectUrl.searchParams.get("redirect_uri")
    // Falls back to http://localhost when no host header
    expect(redirectUri).toBe("http://localhost/oauth/oauth2test/callback")
  })
})
