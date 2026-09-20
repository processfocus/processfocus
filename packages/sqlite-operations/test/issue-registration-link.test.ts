import { eq } from "drizzle-orm"
import { DateTime, Effect } from "effect"
import * as schema from "@pf/drizzle-sqlite"
import {
  InvitationLifecycleStatus,
  InvitationSource,
  SettingsQueries,
  issueRegistrationLinkForEmail,
} from "@pf/graphql-db-operations"
import {
  decryptRegistrationLinkToken,
  hashRegistrationLinkToken,
} from "@pf/graphql-schema"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite"
import { DatabaseTest } from "@pf/service-drizzle-sqlite/test"
import { SqliteSettingsQueriesLive } from "../src/lib/settings-queries.js"
import { describe, expect, it } from "bun:test"

const secret = "customer-invitation-registration-secret-32b!!"
const organisationScope = "pf-2781-7720-6987-prd"
const frontendOrigin = "https://prd.2781-7720-6987.app.processfocus.com"

const run = <A, E>(
  effect: Effect.Effect<A, E, TypedSqliteDrizzle | SettingsQueries>,
) =>
  Effect.runPromise(
    Effect.provide(
      Effect.provide(effect, SqliteSettingsQueriesLive),
      DatabaseTest,
    ),
  )

const seedInvitation = (input: {
  readonly email: string
  readonly status?: string
  readonly withRole?: boolean
  readonly withPasskey?: boolean
}) =>
  Effect.gen(function* () {
    const db = yield* TypedSqliteDrizzle
    const [org] = yield* db
      .insert(schema.orgUnit)
      .values({
        name: "Root",
        orgUnitLevel: "root",
        path: "/",
      })
      .returning()
    if (!org) throw new Error("org")

    const status = input.status ?? InvitationLifecycleStatus.Pending
    const [invitation] = yield* db
      .insert(schema.invitation)
      .values({
        invitationId: `invite-${input.email}`,
        email: input.email,
        invitationStatus: status,
        invitationSource: InvitationSource.Dashboard,
        invitationPendingEmail:
          status === InvitationLifecycleStatus.Pending ? input.email : null,
      })
      .returning()
    if (!invitation) throw new Error("invitation")

    if (input.withRole !== false) {
      const [role] = yield* db
        .insert(schema.role)
        .values({
          name: "Employee",
          orgUnitId: org.id,
          path: "/Employee",
        })
        .returning()
      if (!role) throw new Error("role")

      yield* db.insert(schema.invitationRole).values({
        invitationId: invitation.id,
        roleId: role.id,
      })
    }

    if (input.withPasskey !== false) {
      yield* db.insert(schema.oauthProvider).values({
        providerName: "passkey",
        providerConfig: {
          rpName: "Test",
          rpID: "localhost",
          origin: "http://localhost:3000",
        },
      })
    }

    return { org, invitation }
  })

const tokenFromUrl = (url: string): string => {
  const match = url.match(/#token=(.+)$/)
  if (!match?.[1]) {
    throw new Error(`URL did not contain a token fragment: ${url}`)
  }
  return match[1]
}

describe("issueRegistrationLinkForEmail", () => {
  it("rotates expired pending links but refuses revoked links", async () => {
    await run(
      Effect.gen(function* () {
        const email = "expired@example.com"
        const { invitation } = yield* seedInvitation({ email })
        const input = {
          email,
          actor: "admin",
          organisationScope,
          frontendOrigin,
          secret,
        }
        const first = yield* issueRegistrationLinkForEmail({
          ...input,
          rotate: false,
        })
        expect(first.ok).toBe(true)
        const db = yield* TypedSqliteDrizzle
        yield* db
          .update(schema.invitation)
          .set({
            registrationLinkExpiresAt: DateTime.add(yield* DateTime.now, {
              hours: -1,
            }),
          })
          .where(eq(schema.invitation.id, invitation.id))
        const rotated = yield* issueRegistrationLinkForEmail({
          ...input,
          rotate: true,
        })
        expect(rotated.ok).toBe(true)
        const settings = yield* SettingsQueries
        yield* settings.revokeRegistrationLink(invitation.id, "admin")
        expect(
          (yield* issueRegistrationLinkForEmail({ ...input, rotate: true })).ok,
        ).toBe(false)
      }),
    )
  })

  it("generates a URL and stores hash/envelope for a pending invite", async () => {
    const email = "first-admin@example.com"

    await run(
      Effect.gen(function* () {
        const { invitation } = yield* seedInvitation({ email })
        const settings = yield* SettingsQueries

        const result = yield* issueRegistrationLinkForEmail({
          email: `  ${email.toUpperCase()}  `,
          rotate: false,
          actor: "console-admin@example.com",
          organisationScope,
          frontendOrigin,
          secret,
        })

        expect(result.ok).toBe(true)
        if (!result.ok) {
          return
        }

        expect(result.email).toBe(email)
        expect(
          result.registrationLinkUrl.startsWith(
            `${frontendOrigin}/register/passkey#token=`,
          ),
        ).toBe(true)
        expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now())

        const live = yield* settings.queryLiveRegistrationLink(
          invitation.id,
          DateTime.toDateUtc(yield* DateTime.now),
        )
        expect(live).not.toBeNull()
        if (!live) {
          return
        }

        const rawToken = tokenFromUrl(result.registrationLinkUrl)
        expect(live.tokenHash).toBe(hashRegistrationLinkToken(rawToken))

        const decrypted = yield* decryptRegistrationLinkToken({
          organisationScope,
          invitationId: invitation.id,
          tokenHash: live.tokenHash,
          expiresAtUnixMs: Math.round(live.expiresAt.getTime() / 1000) * 1000,
          envelope: {
            encryptionVersion: live.encryptionVersion,
            nonce: live.nonce,
            authenticationTag: live.authenticationTag,
            ciphertext: live.ciphertext,
          },
          secret,
        })
        expect(decrypted).toBe(rawToken)
      }),
    )
  })

  it("rotate invalidates the previous hash", async () => {
    const email = "rotate-admin@example.com"

    await run(
      Effect.gen(function* () {
        const { invitation } = yield* seedInvitation({ email })
        const settings = yield* SettingsQueries

        const first = yield* issueRegistrationLinkForEmail({
          email,
          rotate: false,
          actor: "console-admin@example.com",
          organisationScope,
          frontendOrigin,
          secret,
        })
        expect(first.ok).toBe(true)
        if (!first.ok) {
          return
        }

        const firstLive = yield* settings.queryLiveRegistrationLink(
          invitation.id,
          DateTime.toDateUtc(yield* DateTime.now),
        )
        const firstHash = firstLive?.tokenHash
        expect(firstHash).toBeDefined()

        const rotated = yield* issueRegistrationLinkForEmail({
          email,
          rotate: true,
          actor: "console-admin@example.com",
          organisationScope,
          frontendOrigin,
          secret,
        })
        expect(rotated.ok).toBe(true)
        if (!rotated.ok) {
          return
        }

        const secondLive = yield* settings.queryLiveRegistrationLink(
          invitation.id,
          DateTime.toDateUtc(yield* DateTime.now),
        )
        expect(secondLive?.tokenHash).toBeDefined()
        expect(secondLive?.tokenHash).not.toBe(firstHash)
        expect(tokenFromUrl(rotated.registrationLinkUrl)).not.toBe(
          tokenFromUrl(first.registrationLinkUrl),
        )
      }),
    )
  })

  it("fails for an accepted invitation", async () => {
    await run(
      Effect.gen(function* () {
        yield* seedInvitation({
          email: "accepted@example.com",
          status: InvitationLifecycleStatus.Accepted,
        })

        const result = yield* issueRegistrationLinkForEmail({
          email: "accepted@example.com",
          rotate: false,
          actor: "console-admin@example.com",
          organisationScope,
          frontendOrigin,
          secret,
        })

        expect(result.ok).toBe(false)
        if (result.ok) {
          return
        }
        expect(result.error).toContain("can no longer be changed")
      }),
    )
  })

  it("fails for a missing email", async () => {
    await run(
      Effect.gen(function* () {
        const result = yield* issueRegistrationLinkForEmail({
          email: "missing@example.com",
          rotate: false,
          actor: "console-admin@example.com",
          organisationScope,
          frontendOrigin,
          secret,
        })

        expect(result.ok).toBe(false)
        if (result.ok) {
          return
        }
        expect(result.error).toBe("Invitation not found")
      }),
    )
  })

  it("fails when passkey is disabled", async () => {
    await run(
      Effect.gen(function* () {
        yield* seedInvitation({
          email: "nopasskey@example.com",
          withPasskey: false,
        })

        const result = yield* issueRegistrationLinkForEmail({
          email: "nopasskey@example.com",
          rotate: false,
          actor: "console-admin@example.com",
          organisationScope,
          frontendOrigin,
          secret,
        })

        expect(result.ok).toBe(false)
        if (result.ok) {
          return
        }
        expect(result.error).toContain("passkey provider is disabled")
      }),
    )
  })

  it("fails when an active link exists and rotate is false", async () => {
    await run(
      Effect.gen(function* () {
        yield* seedInvitation({ email: "already-active@example.com" })

        const first = yield* issueRegistrationLinkForEmail({
          email: "already-active@example.com",
          rotate: false,
          actor: "console-admin@example.com",
          organisationScope,
          frontendOrigin,
          secret,
        })
        expect(first.ok).toBe(true)

        const second = yield* issueRegistrationLinkForEmail({
          email: "already-active@example.com",
          rotate: false,
          actor: "console-admin@example.com",
          organisationScope,
          frontendOrigin,
          secret,
        })
        expect(second.ok).toBe(false)
        if (second.ok) {
          return
        }
        expect(second.error).toContain("already exists")
      }),
    )
  })
})
