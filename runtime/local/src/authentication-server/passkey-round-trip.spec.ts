/// <reference lib="dom" />

import { existsSync } from "node:fs"
import { FetchHttpClient, HttpApp } from "@effect/platform"
import { type BrowserContext, type Page, chromium } from "@playwright/test"
import { and, eq } from "drizzle-orm"
import { DateTime, Effect, Layer, Option } from "effect"
import { SignJWT } from "jose"
import {
  AuthenticationDatabase,
  createAuthenticationServer,
} from "@pf/auth-api"
import * as schema from "@pf/drizzle-sqlite"
import { KeyManagementService, KeyManagementServiceLive } from "@pf/openauth"
import { createClient } from "@pf/openauth/client"
import {
  DatabaseTest,
  TypedSqliteDrizzle,
} from "@pf/service-drizzle-sqlite/test"
import {
  SqliteAuthenticationDatabaseLive,
  SqliteOpenAuthStorageServiceLive,
} from "@pf/sqlite-operations"
import { describe, expect, it } from "bun:test"

interface RegistrationCeremony {
  readonly challengeId: string
  readonly requiredResidentKey: boolean
  readonly requiredUserVerification: boolean
  readonly requestedUserHandle: string
  readonly response: {
    readonly id: string
    readonly rawId: string
    readonly type: "public-key"
    readonly clientExtensionResults: AuthenticationExtensionsClientOutputs
    readonly response: {
      readonly clientDataJSON: string
      readonly attestationObject: string
      readonly transports: readonly string[]
    }
  }
}

interface AuthenticationCeremony {
  readonly challengeId: string
  readonly hadAllowCredentials: boolean
  readonly requiredUserVerification: boolean
  readonly response: {
    readonly id: string
    readonly rawId: string
    readonly type: "public-key"
    readonly clientExtensionResults: AuthenticationExtensionsClientOutputs
    readonly response: {
      readonly clientDataJSON: string
      readonly authenticatorData: string
      readonly signature: string
      readonly userHandle: string
    }
  }
}

const AuthenticationLayer = SqliteAuthenticationDatabaseLive.pipe(
  Layer.provideMerge(DatabaseTest),
)
const TestLayer = SqliteOpenAuthStorageServiceLive.pipe(
  Layer.provideMerge(AuthenticationLayer),
  Layer.provideMerge(FetchHttpClient.layer),
)
const itWithChromium = existsSync(chromium.executablePath()) ? it : it.skip

const startAuthorization = async (
  page: Page,
  issuer: string,
): Promise<void> => {
  const client = createClient({ issuer, clientID: "passkey-round-trip" })
  const { url } = await client.authorize(
    "http://localhost:3000/callback",
    "code",
    { provider: "passkey" },
  )
  const response = await page.goto(url)
  expect(response?.status()).toBe(200)
  await page.goto(`${issuer}/webauthn-test`)
}

const postJson = async (
  context: BrowserContext,
  url: string,
  data: unknown,
  headers: Record<string, string> = {},
): Promise<Response> => {
  const cookies = await context.cookies(url)
  const cookieHeader = cookies
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ")

  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      ...headers,
    },
    body: JSON.stringify(data),
    redirect: "manual",
  })
}

const prepareRegistration = async (
  context: BrowserContext,
  page: Page,
  issuer: string,
  email: string,
): Promise<RegistrationCeremony> => {
  const optionsResponse = await postJson(
    context,
    `${issuer}/oauth/passkey/register-options`,
    { email },
  )
  expect(optionsResponse.status).toBe(200)
  const body = (await optionsResponse.json()) as {
    challengeId: string
    options: Omit<
      PublicKeyCredentialCreationOptions,
      "challenge" | "excludeCredentials" | "user"
    > & {
      challenge: string
      user: Omit<PublicKeyCredentialUserEntity, "id"> & { id: string }
      excludeCredentials?: readonly (Omit<
        PublicKeyCredentialDescriptor,
        "id"
      > & {
        id: string
      })[]
    }
  }

  return prepareRegistrationFromOptions(page, body)
}

const prepareRegistrationFromOptions = async (
  page: Page,
  body: {
    readonly challengeId: string
    readonly options: Omit<
      PublicKeyCredentialCreationOptions,
      "challenge" | "excludeCredentials" | "user"
    > & {
      challenge: string
      user: Omit<PublicKeyCredentialUserEntity, "id"> & { id: string }
      excludeCredentials?: readonly (Omit<
        PublicKeyCredentialDescriptor,
        "id"
      > & {
        id: string
      })[]
    }
  },
): Promise<RegistrationCeremony> =>
  page.evaluate(async (body) => {
    const fromBase64Url = (value: string): Uint8Array<ArrayBuffer> => {
      const base64 = value.replaceAll("-", "+").replaceAll("_", "/")
      const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")
      const binary = atob(padded)
      const bytes = new Uint8Array(new ArrayBuffer(binary.length))
      bytes.forEach((_, index) => {
        bytes[index] = binary.charCodeAt(index)
      })
      return bytes
    }
    const toBase64Url = (value: BufferSource): string => {
      const bytes =
        value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      const binary = String.fromCharCode(...bytes)
      return btoa(binary)
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", "")
    }

    const { challenge, excludeCredentials, user, ...options } = body.options
    const publicKey: PublicKeyCredentialCreationOptions = {
      ...options,
      challenge: fromBase64Url(challenge),
      user: {
        ...user,
        id: fromBase64Url(user.id),
      },
      ...(excludeCredentials && {
        excludeCredentials: excludeCredentials.map((descriptor) => ({
          ...descriptor,
          id: fromBase64Url(descriptor.id),
        })),
      }),
    }
    const credential = (await navigator.credentials.create({
      publicKey,
    })) as PublicKeyCredential | null
    if (!credential) throw new Error("Authenticator returned no credential")
    const attestation = credential.response as AuthenticatorAttestationResponse

    return {
      challengeId: body.challengeId,
      requiredResidentKey:
        publicKey.authenticatorSelection?.residentKey === "required" &&
        publicKey.authenticatorSelection.requireResidentKey === true,
      requiredUserVerification:
        publicKey.authenticatorSelection?.userVerification === "required",
      requestedUserHandle: toBase64Url(publicKey.user.id),
      response: {
        id: credential.id,
        rawId: toBase64Url(credential.rawId),
        type: "public-key" as const,
        clientExtensionResults: credential.getClientExtensionResults(),
        response: {
          clientDataJSON: toBase64Url(attestation.clientDataJSON),
          attestationObject: toBase64Url(attestation.attestationObject),
          transports: attestation.getTransports(),
        },
      },
    }
  }, body)

const prepareAuthentication = async (
  context: BrowserContext,
  page: Page,
  issuer: string,
): Promise<AuthenticationCeremony> => {
  const optionsResponse = await postJson(
    context,
    `${issuer}/oauth/passkey/auth-options`,
    {},
  )
  expect(optionsResponse.status).toBe(200)
  const body = (await optionsResponse.json()) as {
    challengeId: string
    options: Omit<
      PublicKeyCredentialRequestOptions,
      "allowCredentials" | "challenge"
    > & {
      challenge: string
      allowCredentials?: readonly (Omit<PublicKeyCredentialDescriptor, "id"> & {
        id: string
      })[]
    }
  }

  return page.evaluate(async (body) => {
    const fromBase64Url = (value: string): Uint8Array<ArrayBuffer> => {
      const base64 = value.replaceAll("-", "+").replaceAll("_", "/")
      const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")
      const binary = atob(padded)
      const bytes = new Uint8Array(new ArrayBuffer(binary.length))
      bytes.forEach((_, index) => {
        bytes[index] = binary.charCodeAt(index)
      })
      return bytes
    }
    const toBase64Url = (value: BufferSource): string => {
      const bytes =
        value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      const binary = String.fromCharCode(...bytes)
      return btoa(binary)
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", "")
    }

    const hadAllowCredentials = Object.hasOwn(body.options, "allowCredentials")
    const { allowCredentials, challenge, ...options } = body.options
    const publicKey: PublicKeyCredentialRequestOptions = {
      ...options,
      challenge: fromBase64Url(challenge),
      ...(allowCredentials && {
        allowCredentials: allowCredentials.map((descriptor) => ({
          ...descriptor,
          id: fromBase64Url(descriptor.id),
        })),
      }),
    }
    const credential = (await navigator.credentials.get({
      publicKey,
    })) as PublicKeyCredential | null
    if (!credential) throw new Error("Authenticator returned no assertion")
    const assertion = credential.response as AuthenticatorAssertionResponse
    if (!assertion.userHandle) {
      throw new Error("Discoverable assertion did not contain a user handle")
    }

    return {
      challengeId: body.challengeId,
      hadAllowCredentials,
      requiredUserVerification: publicKey.userVerification === "required",
      response: {
        id: credential.id,
        rawId: toBase64Url(credential.rawId),
        type: "public-key" as const,
        clientExtensionResults: credential.getClientExtensionResults(),
        response: {
          clientDataJSON: toBase64Url(assertion.clientDataJSON),
          authenticatorData: toBase64Url(assertion.authenticatorData),
          signature: toBase64Url(assertion.signature),
          userHandle: toBase64Url(assertion.userHandle),
        },
      },
    }
  }, body)
}

describe("passkey auth-server real round trip", () => {
  itWithChromium(
    "registers and signs in usernameless, rejects replay, and keeps identity writes atomic",
    async () => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const db = yield* TypedSqliteDrizzle
            const [rootOrgUnit] = yield* db
              .insert(schema.orgUnit)
              .values({
                name: "Root Organization",
                orgUnitLevel: "root",
                path: "/",
                parentOrgUnitId: null,
              })
              .returning({ id: schema.orgUnit.id })
            if (!rootOrgUnit) throw new Error("Failed to create root org unit")

            const { app, runtime } = yield* createAuthenticationServer({
              clients: [
                {
                  id: "passkey-round-trip",
                  redirectUris: ["http://localhost:3000/callback"],
                },
              ],
            })
            const handler = HttpApp.toWebHandlerRuntime(runtime)(app)
            const server = yield* Effect.acquireRelease(
              Effect.sync(() =>
                Bun.serve({
                  port: 0,
                  fetch: (request) =>
                    new URL(request.url).pathname === "/webauthn-test"
                      ? new Response(
                          "<!doctype html><title>WebAuthn test</title>",
                          {
                            headers: { "Content-Type": "text/html" },
                          },
                        )
                      : handler(request),
                }),
              ),
              (server) => Effect.promise(() => server.stop()),
            )
            const issuer = `http://localhost:${server.port}`

            yield* db.insert(schema.oauthProvider).values({
              providerName: "passkey",
              providerConfig: {
                rpName: "Passkey Round Trip",
                rpID: "localhost",
                origin: issuer,
                inviteOnly: false,
              },
            })

            const browser = yield* Effect.acquireRelease(
              Effect.promise(() => chromium.launch()),
              (browser) => Effect.promise(() => browser.close()),
            )
            const context = yield* Effect.acquireRelease(
              Effect.promise(() => browser.newContext()),
              (context) => Effect.promise(() => context.close()),
            )
            const page = yield* Effect.promise(() => context.newPage())
            const cdp = yield* Effect.promise(() => context.newCDPSession(page))
            yield* Effect.promise(() => cdp.send("WebAuthn.enable"))
            yield* Effect.promise(() =>
              cdp.send("WebAuthn.addVirtualAuthenticator", {
                options: {
                  protocol: "ctap2",
                  ctap2Version: "ctap2_1",
                  transport: "internal",
                  hasResidentKey: true,
                  hasUserVerification: true,
                  isUserVerified: true,
                  automaticPresenceSimulation: true,
                },
              }),
            )
            yield* Effect.promise(() => page.goto(`${issuer}/webauthn-test`))

            const firstEmail = "person+tag@example.com"
            yield* Effect.promise(() => startAuthorization(page, issuer))
            const firstRegistration = yield* Effect.promise(() =>
              prepareRegistration(context, page, issuer, firstEmail),
            )
            const registrationResponse = yield* Effect.promise(() =>
              postJson(context, `${issuer}/oauth/passkey/register-verify`, {
                challengeId: firstRegistration.challengeId,
                response: firstRegistration.response,
              }),
            )
            expect(registrationResponse.status).toBe(302)
            expect(firstRegistration.requiredResidentKey).toBeTrue()
            expect(firstRegistration.requiredUserVerification).toBeTrue()

            const firstRows = yield* db
              .select({
                email: schema.providerUser.email,
                userId: schema.user.id,
                userHandle: schema.user.sub,
                credentialUserId: schema.passkeyCredential.userId,
                credentialId: schema.passkeyCredential.passkeyCredentialId,
                publicKey: schema.passkeyCredential.passkeyPublicKey,
                counter: schema.passkeyCredential.signatureCounter,
                transports: schema.passkeyCredential.passkeyTransports,
                lastUsedAt: schema.passkeyCredential.passkeyLastUsedAt,
              })
              .from(schema.providerUser)
              .innerJoin(
                schema.user,
                eq(schema.providerUser.userId, schema.user.id),
              )
              .innerJoin(
                schema.passkeyCredential,
                eq(schema.passkeyCredential.userId, schema.user.id),
              )
              .where(eq(schema.providerUser.email, firstEmail))
            expect(firstRows).toHaveLength(1)
            expect(firstRows[0]).toEqual(
              expect.objectContaining({
                email: firstEmail,
                userHandle: firstRegistration.requestedUserHandle,
                credentialUserId: firstRows[0]?.userId,
                credentialId: firstRegistration.response.id,
              }),
            )
            expect(firstRows[0]?.publicKey.length).toBeGreaterThan(40)
            expect(firstRows[0]?.transports).toContain("internal")
            expect(
              Buffer.from(firstRows[0]?.userHandle ?? "", "base64url"),
            ).toHaveLength(32)
            expect(firstRows[0]?.userHandle).not.toContain(firstEmail)
            expect(firstRows[0]?.lastUsedAt).toBeNull()

            yield* Effect.promise(() => startAuthorization(page, issuer))
            const authentication = yield* Effect.promise(() =>
              prepareAuthentication(context, page, issuer),
            )
            expect(authentication.hadAllowCredentials).toBeFalse()
            expect(authentication.requiredUserVerification).toBeTrue()
            expect(authentication.response.response.userHandle).toBe(
              firstRows[0]?.userHandle ?? "missing user handle",
            )
            const authenticationBody = {
              challengeId: authentication.challengeId,
              response: authentication.response,
            }
            const authenticationResponse = yield* Effect.promise(() =>
              postJson(
                context,
                `${issuer}/oauth/passkey/auth-verify`,
                authenticationBody,
              ),
            )
            expect(authenticationResponse.status).toBe(302)

            const replayResponse = yield* Effect.promise(() =>
              postJson(
                context,
                `${issuer}/oauth/passkey/auth-verify`,
                authenticationBody,
              ),
            )
            expect(replayResponse.status).toBe(400)
            expect(yield* Effect.promise(() => replayResponse.json())).toEqual({
              error: "Invalid or expired challenge",
            })

            const [advancedCredential] = yield* db
              .select({
                counter: schema.passkeyCredential.signatureCounter,
                lastUsedAt: schema.passkeyCredential.passkeyLastUsedAt,
              })
              .from(schema.passkeyCredential)
              .where(
                eq(
                  schema.passkeyCredential.passkeyCredentialId,
                  firstRegistration.response.id,
                ),
              )
            expect(Number(advancedCredential?.counter)).toBeGreaterThan(
              Number(firstRows[0]?.counter),
            )
            expect(advancedCredential?.lastUsedAt).not.toBeNull()

            const secondEmail = "person.tag@example.com"
            yield* Effect.promise(() => startAuthorization(page, issuer))
            const secondRegistration = yield* Effect.promise(() =>
              prepareRegistration(context, page, issuer, secondEmail),
            )
            const secondResponse = yield* Effect.promise(() =>
              postJson(context, `${issuer}/oauth/passkey/register-verify`, {
                challengeId: secondRegistration.challengeId,
                response: secondRegistration.response,
              }),
            )
            expect(secondResponse.status).toBe(302)

            const punctuationUsers = yield* db
              .select({
                email: schema.providerUser.email,
                handle: schema.user.sub,
              })
              .from(schema.providerUser)
              .innerJoin(
                schema.user,
                eq(schema.providerUser.userId, schema.user.id),
              )
              .where(
                and(
                  eq(schema.user.provider, "passkey"),
                  eq(schema.providerUser._deleted, false),
                ),
              )
            const handles = new Map(
              punctuationUsers.map(({ email, handle }) => [email, handle]),
            )
            expect(handles.get(firstEmail)).toBe(
              firstRegistration.requestedUserHandle,
            )
            expect(handles.get(secondEmail)).toBe(
              secondRegistration.requestedUserHandle,
            )
            expect(handles.get(firstEmail)).not.toBe(handles.get(secondEmail))

            const collisionEmail = "collision-contender@example.com"
            yield* Effect.promise(() => startAuthorization(page, issuer))
            const collisionRegistration = yield* Effect.promise(() =>
              prepareRegistration(context, page, issuer, collisionEmail),
            )
            const now = yield* DateTime.now
            const [owner] = yield* db
              .insert(schema.user)
              .values({
                provider: "passkey",
                sub: "collision-owner-handle",
                lastLoggedIn: now,
              })
              .returning()
            if (!owner) throw new Error("Failed to create collision owner")
            yield* db.insert(schema.providerUser).values({
              userId: owner.id,
              email: "collision-owner@example.com",
              name: "Collision Owner",
              firstName: "Collision",
              lastName: "Owner",
              picture: "",
              locale: "en",
              orgUnitId: rootOrgUnit.id,
            })
            yield* db.insert(schema.passkeyCredential).values({
              userId: owner.id,
              passkeyCredentialId: collisionRegistration.response.id,
              passkeyPublicKey: "collision-owner-public-key",
              signatureCounter: "0",
              passkeyTransports: ["internal"],
            })

            const collisionResponse = yield* Effect.promise(() =>
              postJson(context, `${issuer}/oauth/passkey/register-verify`, {
                challengeId: collisionRegistration.challengeId,
                response: collisionRegistration.response,
              }),
            )
            expect(collisionResponse.status).toBe(302)
            expect(collisionResponse.headers.get("location")).toContain(
              "error=access_denied",
            )

            const contenderProviderUsers = yield* db
              .select()
              .from(schema.providerUser)
              .where(eq(schema.providerUser.email, collisionEmail))
            const contenderUsers = yield* db
              .select()
              .from(schema.user)
              .where(
                eq(schema.user.sub, collisionRegistration.requestedUserHandle),
              )
            const collidingCredentials = yield* db
              .select()
              .from(schema.passkeyCredential)
              .where(
                eq(
                  schema.passkeyCredential.passkeyCredentialId,
                  collisionRegistration.response.id,
                ),
              )
            expect(contenderProviderUsers).toHaveLength(0)
            expect(contenderUsers).toHaveLength(0)
            expect(collidingCredentials).toHaveLength(1)
            expect(collidingCredentials[0]?.userId).toBe(owner.id)
          }),
        ).pipe(Effect.provide(TestLayer)),
      )
    },
    { timeout: 30_000 },
  )

  itWithChromium(
    "adds a second independent credential from a signed-in session and signs in with both",
    async () => {
      const managementLayer = Layer.mergeAll(
        TestLayer,
        KeyManagementServiceLive.pipe(Layer.provide(TestLayer)),
      )
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const db = yield* TypedSqliteDrizzle
            const authDb = yield* AuthenticationDatabase
            const [rootOrgUnit] = yield* db
              .insert(schema.orgUnit)
              .values({
                name: "Root Organization",
                orgUnitLevel: "root",
                path: "/",
                parentOrgUnitId: null,
              })
              .returning({ id: schema.orgUnit.id })
            if (!rootOrgUnit) throw new Error("Failed to create root org unit")

            const { app, runtime } = yield* createAuthenticationServer({
              clients: [
                {
                  id: "passkey-round-trip",
                  redirectUris: ["http://localhost:3000/callback"],
                  audience: "passkey-round-trip",
                },
              ],
            })
            const handler = HttpApp.toWebHandlerRuntime(runtime)(app)
            const server = yield* Effect.acquireRelease(
              Effect.sync(() =>
                Bun.serve({
                  port: 0,
                  fetch: (request) =>
                    new URL(request.url).pathname === "/webauthn-test"
                      ? new Response(
                          "<!doctype html><title>WebAuthn test</title>",
                          {
                            headers: { "Content-Type": "text/html" },
                          },
                        )
                      : handler(request),
                }),
              ),
              (server) => Effect.promise(() => server.stop()),
            )
            const issuer = `http://localhost:${server.port}`
            yield* db.insert(schema.oauthProvider).values({
              providerName: "passkey",
              providerConfig: {
                rpName: "Passkey Management Round Trip",
                rpID: "localhost",
                origin: issuer,
                inviteOnly: false,
              },
            })

            const browser = yield* Effect.acquireRelease(
              Effect.promise(() => chromium.launch()),
              (browser) => Effect.promise(() => browser.close()),
            )
            const context = yield* Effect.acquireRelease(
              Effect.promise(() => browser.newContext()),
              (context) => Effect.promise(() => context.close()),
            )
            const page = yield* Effect.promise(() => context.newPage())
            const cdp = yield* Effect.promise(() => context.newCDPSession(page))
            yield* Effect.promise(() => cdp.send("WebAuthn.enable"))
            const authenticatorOptions = {
              protocol: "ctap2" as const,
              ctap2Version: "ctap2_1" as const,
              transport: "internal" as const,
              hasResidentKey: true,
              hasUserVerification: true,
              isUserVerified: true,
              automaticPresenceSimulation: true,
            }
            const firstAuthenticator = yield* Effect.promise(() =>
              cdp.send("WebAuthn.addVirtualAuthenticator", {
                options: authenticatorOptions,
              }),
            )
            yield* Effect.promise(() => page.goto(`${issuer}/webauthn-test`))

            const email = "spare-key@example.com"
            yield* Effect.promise(() => startAuthorization(page, issuer))
            const firstRegistration = yield* Effect.promise(() =>
              prepareRegistration(context, page, issuer, email),
            )
            const firstVerify = yield* Effect.promise(() =>
              postJson(context, `${issuer}/oauth/passkey/register-verify`, {
                challengeId: firstRegistration.challengeId,
                response: firstRegistration.response,
              }),
            )
            expect(firstVerify.status).toBe(302)

            const owner = yield* authDb.findProviderUserByEmail(email)
            if (Option.isNone(owner)) throw new Error("Missing owner")
            const key = yield* (yield* KeyManagementService).signingKey
            const clock = yield* Effect.clock
            const token = yield* Effect.promise(() =>
              new SignJWT({
                mode: "access",
                type: "providerUser",
                properties: {
                  humanSession: true,
                  userId: owner.value.id,
                  email: owner.value.email,
                  orgUnitId: owner.value.orgUnitId,
                  orgUnitPath: owner.value.orgUnitPath,
                  roles: [],
                },
              })
                .setProtectedHeader({ alg: key.alg, kid: key.id })
                .setIssuer(issuer)
                .setAudience("passkey-round-trip")
                .setSubject(`providerUser:${owner.value.id}`)
                .setIssuedAt(Math.floor(clock.unsafeCurrentTimeMillis() / 1000))
                .setExpirationTime(
                  Math.floor(clock.unsafeCurrentTimeMillis() / 1000) + 3600,
                )
                .sign(key.private),
            )

            const secondAuthenticator = yield* Effect.promise(() =>
              cdp.send("WebAuthn.addVirtualAuthenticator", {
                options: {
                  ...authenticatorOptions,
                  transport: "usb",
                },
              }),
            )
            yield* Effect.promise(() =>
              cdp.send("WebAuthn.setAutomaticPresenceSimulation", {
                authenticatorId: firstAuthenticator.authenticatorId,
                enabled: false,
              }),
            )

            const started = yield* Effect.promise(() =>
              postJson(
                context,
                `${issuer}/oauth/passkeys`,
                { name: "Spare key" },
                { authorization: `Bearer ${token}` },
              ),
            )
            expect(started.status).toBe(200)
            const startedBody = (yield* Effect.promise(() =>
              started.json(),
            )) as Parameters<typeof prepareRegistrationFromOptions>[1]
            expect(startedBody.options.excludeCredentials).toEqual([
              expect.objectContaining({
                id: firstRegistration.response.id,
              }),
            ])

            const secondRegistration = yield* Effect.promise(() =>
              prepareRegistrationFromOptions(page, startedBody),
            )
            const enrolled = yield* Effect.promise(() =>
              postJson(
                context,
                `${issuer}/oauth/passkeys`,
                {
                  challengeId: secondRegistration.challengeId,
                  response: secondRegistration.response,
                },
                { authorization: `Bearer ${token}` },
              ),
            )
            expect(enrolled.status).toBe(200)
            const listed = (yield* Effect.promise(() => enrolled.json())) as {
              credentials: Array<{ name: string | null }>
            }
            expect(listed.credentials).toHaveLength(2)
            expect(
              listed.credentials.some((item) => item.name === "Spare key"),
            ).toBe(true)

            const stored = yield* db.select().from(schema.passkeyCredential)
            expect(stored).toHaveLength(2)
            expect(stored.map((row) => row.passkeyCredentialId).sort()).toEqual(
              [
                firstRegistration.response.id,
                secondRegistration.response.id,
              ].sort(),
            )
            expect(firstRegistration.response.id).not.toBe(
              secondRegistration.response.id,
            )

            yield* Effect.promise(() =>
              cdp.send("WebAuthn.setAutomaticPresenceSimulation", {
                authenticatorId: firstAuthenticator.authenticatorId,
                enabled: false,
              }),
            )
            yield* Effect.promise(() => startAuthorization(page, issuer))
            const secondAuth = yield* Effect.promise(() =>
              prepareAuthentication(context, page, issuer),
            )
            const secondAuthResponse = yield* Effect.promise(() =>
              postJson(context, `${issuer}/oauth/passkey/auth-verify`, {
                challengeId: secondAuth.challengeId,
                response: secondAuth.response,
              }),
            )
            expect(secondAuthResponse.status).toBe(302)
            expect(secondAuth.response.id).toBe(secondRegistration.response.id)

            yield* Effect.promise(() =>
              cdp.send("WebAuthn.setAutomaticPresenceSimulation", {
                authenticatorId: firstAuthenticator.authenticatorId,
                enabled: true,
              }),
            )
            yield* Effect.promise(() =>
              cdp.send("WebAuthn.setAutomaticPresenceSimulation", {
                authenticatorId: secondAuthenticator.authenticatorId,
                enabled: false,
              }),
            )
            yield* Effect.promise(() => startAuthorization(page, issuer))
            const firstAuth = yield* Effect.promise(() =>
              prepareAuthentication(context, page, issuer),
            )
            const firstAuthResponse = yield* Effect.promise(() =>
              postJson(context, `${issuer}/oauth/passkey/auth-verify`, {
                challengeId: firstAuth.challengeId,
                response: firstAuth.response,
              }),
            )
            expect(firstAuthResponse.status).toBe(302)
            expect(firstAuth.response.id).toBe(firstRegistration.response.id)
          }),
        ).pipe(Effect.provide(managementLayer)),
      )
    },
    { timeout: 30_000 },
  )
})
