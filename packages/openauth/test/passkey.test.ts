import * as simplewebauthn from "@simplewebauthn/server"
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/types"
import { Effect } from "effect"
import { object, string } from "valibot"
import { createClient } from "../src/client.js"
import {
  type PasskeyConfig,
  type PasskeyCredential,
  type PasskeyProperties,
  PasskeyProvider,
  createPasskeyRegistrationOptions,
  verifyPasskeyRegistrationAttestation,
} from "../src/provider/passkey.js"
import { createSubjects } from "../src/subject.js"
import {
  type TestApp,
  createIssuer,
  createTestAppFromIssuer,
} from "./test-utils.js"
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  spyOn,
  test,
} from "bun:test"

const mockGenerateRegistrationOptions = spyOn(
  simplewebauthn,
  "generateRegistrationOptions",
)
const mockVerifyRegistrationResponse = spyOn(
  simplewebauthn,
  "verifyRegistrationResponse",
)
const mockGenerateAuthenticationOptions = spyOn(
  simplewebauthn,
  "generateAuthenticationOptions",
)
const mockVerifyAuthenticationResponse = spyOn(
  simplewebauthn,
  "verifyAuthenticationResponse",
)

const subjects = createSubjects({
  user: object({
    userID: string(),
  }),
})

type PasskeySuccess = PasskeyProperties & { readonly provider: "passkey" }

interface Harness {
  readonly app: TestApp
  readonly successes: PasskeySuccess[]
  readonly findCredential: ReturnType<
    typeof mock<(credentialId: string) => Promise<PasskeyCredential | undefined>>
  >
}

const createHarness = async (
  config: Partial<PasskeyConfig> = {},
): Promise<Harness> => {
  const successes: PasskeySuccess[] = []
  const findCredential = mock(
    config.findCredential ??
      (async (_credentialId: string): Promise<PasskeyCredential | undefined> =>
        undefined),
  )

  const app = await createTestAppFromIssuer(
    createIssuer({
      subjects,
      clients: [
        {
          id: "web",
          redirectUris: ["https://client.example.com/callback"],
        },
      ],
      providers: {
        passkey: PasskeyProvider({
          rpName: "Test App",
          rpID: "localhost",
          origin: "http://localhost:3000",
          canRegister: async () => ({ allowed: true }),
          ...config,
          findCredential,
        }),
      },
      success: (responder, value) =>
        Effect.gen(function* () {
          const passkeySuccess = value as PasskeySuccess
          successes.push(passkeySuccess)
          return yield* responder.subject("user", {
            userID: passkeySuccess.email,
          })
        }),
    }),
  )

  return { app, successes, findCredential }
}

const startAuthorization = async (app: TestApp): Promise<string> => {
  const client = createClient({
    issuer: "https://auth.example.com",
    clientID: "web",
    fetch: (input, init) => Promise.resolve(app.request(input, init)),
  })
  const { url } = await client.authorize(
    "https://client.example.com/callback",
    "code",
    { pkce: true },
  )
  const response = await app.request(url)
  const cookie = response.headers.get("set-cookie")
  if (!cookie) throw new Error("Authorization did not set a cookie")
  return cookie
}

const jsonPost = (
  app: TestApp,
  path: string,
  body: unknown,
  cookie?: string,
): Promise<Response> =>
  app.request(`https://auth.example.com/oauth/passkey/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  })

const registrationResponse = (
  credentialId = "credential-id",
): RegistrationResponseJSON => ({
  id: credentialId,
  rawId: credentialId,
  type: "public-key",
  clientExtensionResults: {},
  response: {
    clientDataJSON: "registration-client-data",
    attestationObject: "attestation-object",
    transports: ["internal", "hybrid"],
  },
})

const authenticationResponse = (
  userHandle: string,
  credentialId = "credential-id",
): AuthenticationResponseJSON => ({
  id: credentialId,
  rawId: credentialId,
  type: "public-key",
  clientExtensionResults: {},
  response: {
    clientDataJSON: "authentication-client-data",
    authenticatorData: "authenticator-data",
    signature: "signature",
    userHandle,
  },
})

const verifiedRegistration = {
  verified: true as const,
  registrationInfo: {
    fmt: "none" as const,
    aaguid: "00000000-0000-0000-0000-000000000000",
    credential: {
      id: "credential-id",
      publicKey: new Uint8Array([1, 2, 3, 4]),
      counter: 0,
    },
    credentialType: "public-key" as const,
    attestationObject: new Uint8Array(),
    userVerified: true,
    credentialDeviceType: "multiDevice" as const,
    credentialBackedUp: true,
    origin: "http://localhost:3000",
    rpID: "localhost",
  },
}

const verifiedAuthentication = (newCounter: number) => ({
  verified: true as const,
  authenticationInfo: {
    newCounter,
    credentialID: "credential-id",
    userVerified: true,
    credentialDeviceType: "multiDevice" as const,
    credentialBackedUp: true,
    origin: "http://localhost:3000",
    rpID: "localhost",
  },
})

const requestRegistrationOptions = async (
  app: TestApp,
  cookie: string,
): Promise<{ challengeId: string }> => {
  const response = await jsonPost(
    app,
    "register-options",
    { email: "Person@Example.COM" },
    cookie,
  )
  expect(response.status).toBe(200)
  return (await response.json()) as { challengeId: string }
}

const requestAuthenticationOptions = async (
  app: TestApp,
  cookie: string,
): Promise<{ challengeId: string }> => {
  const response = await jsonPost(app, "auth-options", {}, cookie)
  expect(response.status).toBe(200)
  return (await response.json()) as { challengeId: string }
}

const credential: PasskeyCredential = {
  credentialId: "credential-id",
  publicKey: Buffer.from([1, 2, 3, 4]).toString("base64url"),
  counter: 7,
  transports: ["internal"],
  userHandle: "random-user-handle",
  email: "person@example.com",
}

beforeEach(() => {
  setSystemTime(new Date("2024-01-01T00:00:00Z"))
  mockGenerateRegistrationOptions.mockReset()
  mockVerifyRegistrationResponse.mockReset()
  mockGenerateAuthenticationOptions.mockReset()
  mockVerifyAuthenticationResponse.mockReset()

  mockGenerateRegistrationOptions.mockResolvedValue({
    challenge: "registration-challenge",
    rp: { name: "Test App", id: "localhost" },
    user: {
      id: "generated-user-id",
      name: "person@example.com",
      displayName: "person@example.com",
    },
    pubKeyCredParams: [{ alg: -7, type: "public-key" }],
  })
  mockGenerateAuthenticationOptions.mockResolvedValue({
    challenge: "authentication-challenge",
    rpId: "localhost",
  })
})

afterEach(() => {
  setSystemTime()
})

describe("passkey provider", () => {
  test("recovery uses the existing handle and binds verification to the recovery session", async () => {
    mockVerifyRegistrationResponse.mockResolvedValue(verifiedRegistration)
    const context = {
      registrationKind: "recovery" as const, email: "person@example.com",
      userId: "user-1", userHandle: Buffer.from("existing-handle").toString("base64url"),
      recoveryId: "recovery-1", sessionTokenHash: "session-hash",
    }
    let valid = true
    const { app, successes } = await createHarness({
      canRegister: async () => ({ allowed: false, error: "Open registration disabled" }),
      resolveInvitationRegistrationSession: async () => valid
        ? { allowed: true, context }
        : { allowed: false, error: "Invalid recovery session" },
    })
    const cookie = await startAuthorization(app)
    const options = await jsonPost(app, "register-options", { sessionBearer: "session" }, cookie)
    expect(options.status).toBe(200)
    const { challengeId } = await options.json() as { challengeId: string }
    expect(Buffer.from(mockGenerateRegistrationOptions.mock.calls[0]![0].userID!).toString("base64url")).toBe(context.userHandle)
    const response = await jsonPost(app, "register-verify", { challengeId, sessionBearer: "session", response: registrationResponse() }, cookie)
    expect(response.status).toBe(302)
    expect(successes[0]).toMatchObject({ ...context, type: "registration", sessionBearer: "session" })

    const cookie2 = await startAuthorization(app)
    const options2 = await jsonPost(app, "register-options", { sessionBearer: "session" }, cookie2)
    const second = await options2.json() as { challengeId: string }
    valid = false
    const rejected = await jsonPost(app, "register-verify", { challengeId: second.challengeId, sessionBearer: "session", response: registrationResponse() }, cookie2)
    expect(rejected.status).toBe(400)
    expect(successes).toHaveLength(1)
  })

  test("verifyPasskeyRegistrationAttestation reports library failures as unverified", async () => {
    mockVerifyRegistrationResponse.mockRejectedValue(new Error("library boom"))
    const result = await Effect.runPromise(
      verifyPasskeyRegistrationAttestation({
        origin: "http://localhost:3000",
        rpID: "localhost",
        expectedChallenge: "registration-challenge",
        response: {
          id: "credential-id",
          rawId: "credential-id",
          type: "public-key",
          clientExtensionResults: {},
          response: {
            clientDataJSON: "client-data",
            attestationObject: "attestation",
          },
        },
      }),
    )
    expect(result).toEqual({ verified: false })
    expect(mockVerifyRegistrationResponse).toHaveBeenCalled()
  })

  test("createPasskeyRegistrationOptions excludes existing credentials and binds the account handle", async () => {
    const userHandle = Buffer.from("existing-handle").toString("base64url")
    await Effect.runPromise(
      createPasskeyRegistrationOptions({
        rpName: "Test App",
        rpID: "localhost",
        email: "person@example.com",
        userHandle,
        excludeCredentials: [
          { id: "credential-one", transports: ["internal"] },
          { id: "credential-two" },
        ],
      }),
    )
    expect(mockGenerateRegistrationOptions).toHaveBeenCalledTimes(1)
    const options = mockGenerateRegistrationOptions.mock.calls[0]?.[0]
    expect(options).toEqual(
      expect.objectContaining({
        rpName: "Test App",
        rpID: "localhost",
        userName: "person@example.com",
        attestationType: "none",
        authenticatorSelection: {
          residentKey: "required",
          requireResidentKey: true,
          userVerification: "required",
        },
        excludeCredentials: [
          {
            id: "credential-one",
            type: "public-key",
            transports: ["internal"],
          },
          { id: "credential-two", type: "public-key" },
        ],
      }),
    )
    expect(Buffer.from(options?.userID ?? []).toString("utf8")).toBe(
      "existing-handle",
    )
  })

  test("creates random 32-byte user handles and requires resident keys and UV", async () => {
    const { app } = await createHarness()
    const cookie = await startAuthorization(app)

    await requestRegistrationOptions(app, cookie)
    await requestRegistrationOptions(app, cookie)

    expect(mockGenerateRegistrationOptions).toHaveBeenCalledTimes(2)
    const firstOptions = mockGenerateRegistrationOptions.mock.calls[0]?.[0]
    const secondOptions = mockGenerateRegistrationOptions.mock.calls[1]?.[0]
    expect(firstOptions).toEqual(
      expect.objectContaining({
        userName: "person@example.com",
        userDisplayName: "person@example.com",
        attestationType: "none",
        authenticatorSelection: {
          residentKey: "required",
          requireResidentKey: true,
          userVerification: "required",
        },
      }),
    )
    expect(firstOptions?.userID).toBeInstanceOf(Uint8Array)
    expect(firstOptions?.userID).toHaveLength(32)
    expect(secondOptions?.userID).toHaveLength(32)
    expect(firstOptions?.userID).not.toEqual(secondOptions?.userID)
    expect(Buffer.from(firstOptions?.userID ?? []).toString("utf8")).not.toContain(
      "person@example.com",
    )
  })

  test("returns verified registration material without storing the user or credential", async () => {
    mockVerifyRegistrationResponse.mockResolvedValue(verifiedRegistration)
    const { app, successes, findCredential } = await createHarness()
    const registrationCookie = await startAuthorization(app)
    const { challengeId } = await requestRegistrationOptions(
      app,
      registrationCookie,
    )
    const generatedUserId = mockGenerateRegistrationOptions.mock.calls[0]?.[0].userID

    const response = await jsonPost(
      app,
      "register-verify",
      { challengeId, response: registrationResponse() },
      registrationCookie,
    )

    expect(response.status).toBe(302)
    expect(mockVerifyRegistrationResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedChallenge: "registration-challenge",
        requireUserVerification: true,
      }),
    )
    expect(successes).toEqual([
      {
        provider: "passkey",
        type: "registration",
        registrationKind: "open",
        email: "person@example.com",
        userHandle: Buffer.from(generatedUserId ?? []).toString("base64url"),
        credential: {
          id: "credential-id",
          publicKey: "AQIDBA",
          counter: 0,
          transports: ["internal", "hybrid"],
        },
      },
    ])

    const authenticationCookie = await startAuthorization(app)
    const authOptions = await requestAuthenticationOptions(
      app,
      authenticationCookie,
    )
    const unknownCredential = await jsonPost(
      app,
      "auth-verify",
      {
        challengeId: authOptions.challengeId,
        response: authenticationResponse(
          Buffer.from(generatedUserId ?? []).toString("base64url"),
        ),
      },
      authenticationCookie,
    )
    expect(unknownCredential.status).toBe(400)
    expect(await unknownCredential.json()).toEqual({ error: "Unknown credential" })
    expect(findCredential).toHaveBeenCalledWith("credential-id")
  })

  test("revalidates Open Registration eligibility at verification", async () => {
    mockVerifyRegistrationResponse.mockResolvedValue(verifiedRegistration)
    let allow = true
    const canRegister = mock(async () =>
      allow
        ? ({ allowed: true as const })
        : ({ allowed: false as const, error: "Registration is not available for this email" }),
    )
    const { app, successes } = await createHarness({ canRegister })
    const registrationCookie = await startAuthorization(app)
    const { challengeId } = await requestRegistrationOptions(
      app,
      registrationCookie,
    )
    expect(canRegister).toHaveBeenCalledTimes(1)

    allow = false
    const response = await jsonPost(
      app,
      "register-verify",
      { challengeId, response: registrationResponse() },
      registrationCookie,
    )
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: "Registration is not available for this email",
    })
    expect(canRegister).toHaveBeenCalledTimes(2)
    expect(successes).toEqual([])
  })

  test("creates usernameless authentication options with required UV", async () => {
    const { app } = await createHarness()
    const cookie = await startAuthorization(app)

    await requestAuthenticationOptions(app, cookie)

    expect(mockGenerateAuthenticationOptions).toHaveBeenCalledWith({
      rpID: "localhost",
      userVerification: "required",
    })
    expect(
      Object.hasOwn(
        mockGenerateAuthenticationOptions.mock.calls[0]?.[0] ?? {},
        "allowCredentials",
      ),
    ).toBeFalse()
  })

  test("requires an authentication user handle", async () => {
    const { app, findCredential } = await createHarness({
      findCredential: async () => credential,
    })
    const cookie = await startAuthorization(app)
    const { challengeId } = await requestAuthenticationOptions(app, cookie)
    const responseWithoutHandle = authenticationResponse(credential.userHandle)
    const response = await jsonPost(
      app,
      "auth-verify",
      {
        challengeId,
        response: {
          ...responseWithoutHandle,
          response: {
            ...responseWithoutHandle.response,
            userHandle: undefined,
          },
        },
      },
      cookie,
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "Invalid request body" })
    expect(findCredential).not.toHaveBeenCalled()
  })

  test("rejects a credential whose user handle does not match", async () => {
    const { app, findCredential } = await createHarness({
      findCredential: async () => credential,
    })
    const cookie = await startAuthorization(app)
    const { challengeId } = await requestAuthenticationOptions(app, cookie)

    const response = await jsonPost(
      app,
      "auth-verify",
      {
        challengeId,
        response: authenticationResponse("different-user-handle"),
      },
      cookie,
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: "Credential does not match user",
    })
    expect(findCredential).toHaveBeenCalledWith("credential-id")
    expect(mockVerifyAuthenticationResponse).not.toHaveBeenCalled()
  })

  test("looks up credentials in the application and returns counters without storing them", async () => {
    mockVerifyAuthenticationResponse
      .mockResolvedValueOnce(verifiedAuthentication(8))
      .mockResolvedValueOnce(verifiedAuthentication(9))
    const { app, successes, findCredential } = await createHarness({
      findCredential: async () => credential,
    })

    for (const expectedCounter of [8, 9]) {
      const cookie = await startAuthorization(app)
      const { challengeId } = await requestAuthenticationOptions(app, cookie)
      const response = await jsonPost(
        app,
        "auth-verify",
        {
          challengeId,
          response: authenticationResponse(credential.userHandle),
        },
        cookie,
      )
      expect(response.status).toBe(302)
      expect(successes.at(-1)).toEqual({
        provider: "passkey",
        type: "authentication",
        email: credential.email,
        userHandle: credential.userHandle,
        credentialId: credential.credentialId,
        previousCounter: 7,
        newCounter: expectedCounter,
      })
    }

    expect(findCredential).toHaveBeenCalledTimes(2)
    expect(findCredential).toHaveBeenNthCalledWith(1, "credential-id")
    expect(findCredential).toHaveBeenNthCalledWith(2, "credential-id")
    expect(mockVerifyAuthenticationResponse).toHaveBeenCalledTimes(2)
    for (const call of mockVerifyAuthenticationResponse.mock.calls) {
      expect(call[0]).toEqual(
        expect.objectContaining({
          requireUserVerification: true,
          credential: expect.objectContaining({ counter: 7 }),
        }),
      )
    }
  })

  test("consumes an authentication challenge before it can be replayed", async () => {
    mockVerifyAuthenticationResponse.mockResolvedValue(verifiedAuthentication(8))
    const { app } = await createHarness({
      findCredential: async () => credential,
    })
    const firstCookie = await startAuthorization(app)
    const { challengeId } = await requestAuthenticationOptions(app, firstCookie)
    const body = {
      challengeId,
      response: authenticationResponse(credential.userHandle),
    }

    const firstResponse = await jsonPost(app, "auth-verify", body, firstCookie)
    expect(firstResponse.status).toBe(302)

    const replayCookie = await startAuthorization(app)
    const replayResponse = await jsonPost(app, "auth-verify", body, replayCookie)
    expect(replayResponse.status).toBe(400)
    expect(await replayResponse.json()).toEqual({
      error: "Invalid or expired challenge",
    })
    expect(mockVerifyAuthenticationResponse).toHaveBeenCalledTimes(1)
  })
})
