import { object, string } from "valibot"
import { createClient } from "../src/client.js"
import {
  InvalidAccessTokenError,
  InvalidRefreshTokenError,
  OAuthMetadataFetchError,
} from "../src/error.js"
import { DummyProvider } from "../src/provider/dummy.js"
import { createSubjects } from "../src/subject.js"
import {
  type TestApp,
  createIssuer,
  createTestAppFromIssuer,
} from "./test-utils.js"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  spyOn,
  test,
} from "bun:test"

const subjects = createSubjects({
  user: object({
    userID: string(),
  }),
})

let auth: TestApp

beforeAll(async () => {
  auth = await createTestAppFromIssuer(
    createIssuer({
      subjects,
      clients: [
        {
          id: "123",
          redirectUris: ["https://client.example.com/callback"],
        },
      ],
      success: (ctx, _value, _req) =>
        ctx.subject("user", {
          userID: "123",
        }),
      ttl: {
        access: 60,
      },
      providers: {
        dummy: DummyProvider({ email: "foo@bar.com" }),
      },
    }),
  )
})

const expectNonEmptyString = expect.stringMatching(/.+/)

beforeEach(async () => {
  setSystemTime(new Date("1/1/2024"))
})

afterEach(() => {
  setSystemTime()
})

const consoleSpy = spyOn(console, "error").mockImplementation(mock())
afterAll(() => {
  consoleSpy.mockRestore()
})

describe("verify", () => {
  let tokens: { access: string; refresh: string }
  let client: ReturnType<typeof createClient>

  beforeEach(async () => {
    client = createClient({
      // use different issuer per test file to avoid JWKS cache issues
      issuer: "https://auth1.example.com",
      clientID: "123",
      fetch: (a, b) => Promise.resolve(auth.request(a, b)),
    })
    const [verifier, authorization] = await client.pkce(
      "https://client.example.com/callback",
    )
    let response = await auth.request(authorization!)
    response = await auth.request(response.headers.get("location")!, {
      headers: {
        cookie: response.headers.get("set-cookie")!,
      },
    })
    const location = new URL(response.headers.get("location")!)
    const code = location.searchParams.get("code")
    const exchanged = await client.exchange(
      code!,
      "https://client.example.com/callback",
      verifier,
    )
    if (exchanged.err) throw exchanged.err
    tokens = exchanged.tokens
  })

  test("success", async () => {
    const refreshSpy = spyOn(client, "refresh")
    const verified = await client.verify(subjects, tokens.access)
    expect(verified).toStrictEqual({
      aud: "123",
      subject: {
        type: "user",
        properties: {
          userID: "123",
        },
      },
    })
    expect(refreshSpy).not.toBeCalled()
  })

  test("success after refresh", async () => {
    const refreshSpy = spyOn(client, "refresh")
    setSystemTime(Date.now() + 1000 * 6000 + 1000)
    const verified = await client.verify(subjects, tokens.access, {
      refresh: tokens.refresh,
    })
    expect(verified).toStrictEqual({
      aud: "123",
      tokens: {
        expiresIn: 60,
        refreshExpiresIn: expect.any(Number),
        access: expectNonEmptyString,
        refresh: expectNonEmptyString,
      },
      subject: {
        type: "user",
        properties: {
          userID: "123",
        },
      },
    })
    expect(refreshSpy).toBeCalled()
  })

  test("failure with expired access token", async () => {
    setSystemTime(Date.now() + 1000 * 6000 + 1000)
    const verified = await client.verify(subjects, tokens.access)
    expect(verified).toStrictEqual({
      err: expect.any(InvalidAccessTokenError),
    })
  })

  test("failure with invalid refresh token", async () => {
    setSystemTime(Date.now() + 1000 * 6000 + 1000)
    const verified = await client.verify(subjects, tokens.access, {
      refresh: "foo",
    })
    expect(verified).toStrictEqual({
      err: expect.any(InvalidRefreshTokenError),
    })
  })

  test("failure with wrong audience", async () => {
    // Create a client with a different clientID
    const wrongClient = createClient({
      issuer: "https://auth1.example.com",
      clientID: "wrong-client-id",
      fetch: (a, b) => Promise.resolve(auth.request(a, b)),
    })
    // Try to verify a token issued for clientID "123" with a client expecting "wrong-client-id"
    const verified = await wrongClient.verify(subjects, tokens.access)
    expect(verified).toStrictEqual({
      err: expect.any(InvalidAccessTokenError),
    })
  })

  test("returns metadata fetch error when jwks fetch fails", async () => {
    const fetch = mock(
      (input: unknown) => {
        const url = input instanceof URL ? input.toString() : String(input)

        if (url.endsWith("/.well-known/oauth-authorization-server")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              authorization_endpoint: "https://auth1.example.com/oauth/authorize",
              jwks_uri: "https://auth1.example.com/.well-known/jwks.json",
              token_endpoint: "https://auth1.example.com/oauth/token",
            }),
          })
        }

        throw new Error("network timeout")
      },
    )

    const client = createClient({
      issuer: "https://auth1.example.com",
      clientID: "123",
      fetch,
    })

    const verified = await client.verify(subjects, tokens.access)

    expect(verified).toStrictEqual({
      err: expect.any(OAuthMetadataFetchError),
    })

    if (!(verified.err instanceof OAuthMetadataFetchError)) {
      throw new Error("Expected verify to fail")
    }

    expect(verified.err.url).toBe("https://auth1.example.com/.well-known/jwks.json")
    expect(verified.err.message).toContain(
      "Failed to fetch OAuth metadata from https://auth1.example.com/.well-known/jwks.json",
    )
  })

  test("success with explicit audience override", async () => {
    // Create a client with a different clientID
    const differentClient = createClient({
      issuer: "https://auth1.example.com",
      clientID: "different-client-id",
      fetch: (a, b) => Promise.resolve(auth.request(a, b)),
    })
    // Verify with explicit audience override to match the actual token audience
    const verified = await differentClient.verify(subjects, tokens.access, {
      audience: "123",
    })
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
})

describe("authorize with audience", () => {
  test("includes audience in authorization URL when set in ClientInput", async () => {
    const client = createClient({
      issuer: "https://auth.example.com",
      clientID: "my-client",
      audience: "graphql-api",
    })
    const result = await client.authorize(
      "https://client.example.com/callback",
      "code",
      { pkce: false },
    )
    const url = new URL(result.url)
    expect(url.searchParams.get("audience")).toBe("graphql-api")
    expect(url.searchParams.get("client_id")).toBe("my-client")
  })

  test("includes audience in authorization URL when set in AuthorizeOptions", async () => {
    const client = createClient({
      issuer: "https://auth.example.com",
      clientID: "my-client",
    })
    const result = await client.authorize(
      "https://client.example.com/callback",
      "code",
      { pkce: false, audience: "custom-api" },
    )
    const url = new URL(result.url)
    expect(url.searchParams.get("audience")).toBe("custom-api")
  })

  test("AuthorizeOptions audience overrides ClientInput audience", async () => {
    const client = createClient({
      issuer: "https://auth.example.com",
      clientID: "my-client",
      audience: "default-api",
    })
    const result = await client.authorize(
      "https://client.example.com/callback",
      "code",
      { pkce: false, audience: "override-api" },
    )
    const url = new URL(result.url)
    expect(url.searchParams.get("audience")).toBe("override-api")
  })

  test("no audience parameter when not set", async () => {
    const client = createClient({
      issuer: "https://auth.example.com",
      clientID: "my-client",
    })
    const result = await client.authorize(
      "https://client.example.com/callback",
      "code",
      { pkce: false },
    )
    const url = new URL(result.url)
    expect(url.searchParams.get("audience")).toBeNull()
  })
})
