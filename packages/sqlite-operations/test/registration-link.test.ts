import { eq } from "drizzle-orm"
import { DateTime, Effect } from "effect"
import * as schema from "@pf/drizzle-sqlite"
import {
  InvitationLifecycleStatus,
  InvitationSource,
  RegistrationLinkStatus,
  SettingsQueries,
} from "@pf/graphql-db-operations"
import {
  decryptRegistrationLinkToken,
  generateRegistrationLinkMaterial,
} from "@pf/graphql-schema"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite"
import { DatabaseTest } from "@pf/service-drizzle-sqlite/test"
import { SqliteSettingsQueriesLive } from "../src/lib/settings-queries.js"
import { describe, expect, it } from "bun:test"

const run = <A, E>(
  effect: Effect.Effect<A, E, TypedSqliteDrizzle | SettingsQueries>,
) =>
  Effect.runPromise(
    Effect.provide(
      Effect.provide(effect, SqliteSettingsQueriesLive),
      DatabaseTest,
    ),
  )

describe("registration link management", () => {
  const seedPendingInvitation = (email: string) =>
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

      const [role] = yield* db
        .insert(schema.role)
        .values({
          name: "Employee",
          orgUnitId: org.id,
          path: "/Employee",
        })
        .returning()
      if (!role) throw new Error("role")

      yield* db.insert(schema.oauthProvider).values({
        providerName: "passkey",
        providerConfig: {
          rpName: "Test",
          rpID: "localhost",
          origin: "http://localhost:3000",
        },
      })

      const [invitation] = yield* db
        .insert(schema.invitation)
        .values({
          invitationId: `invite-${email}`,
          email,
          invitationStatus: InvitationLifecycleStatus.Pending,
          invitationSource: InvitationSource.Dashboard,
          invitationPendingEmail: email,
        })
        .returning()
      if (!invitation) throw new Error("invitation")

      yield* db.insert(schema.invitationRole).values({
        invitationId: invitation.id,
        roleId: role.id,
      })

      return { org, role, invitation }
    })

  it("starts pending invitations as not-generated with no ticking expiry", async () => {
    await run(
      Effect.gen(function* () {
        const { invitation } = yield* seedPendingInvitation(
          "link-start@example.com",
        )
        const settings = yield* SettingsQueries
        const detail = yield* settings.queryInvitationDetail(invitation.id)
        expect(detail?.registrationLinkStatus).toBe(
          RegistrationLinkStatus.NotGenerated,
        )
        expect(detail?.registrationLinkExpiresAt).toBeNull()
        expect(detail?.registrationLinkGeneration).toBe(0)

        const list = yield* settings.queryAllInvitations(1, 20)
        const row = list.items.find((item) => item.id === invitation.id)
        expect(row?.registrationLinkStatus).toBe(
          RegistrationLinkStatus.NotGenerated,
        )
        // Bulk metadata only — no secret fields exist on the row type.
        expect(
          Object.keys(row ?? {}).some((key) =>
            /tokenHash|ciphertext|nonce|envelope/i.test(key),
          ),
        ).toBe(false)
      }),
    )
  })

  it("stores, reveals without extending expiry, rotates generation, and revokes", async () => {
    await run(
      Effect.gen(function* () {
        const { invitation } = yield* seedPendingInvitation(
          "link-lifecycle@example.com",
        )
        const settings = yield* SettingsQueries
        const now = yield* DateTime.now
        const expiresAt = DateTime.toDateUtc(DateTime.add(now, { days: 7 }))

        const stored = yield* settings.storeRegistrationLink(invitation.id, {
          tokenHash: "hash-token-1",
          encryptionVersion: 1,
          nonce: "nonce-1",
          authenticationTag: "tag-1",
          ciphertext: "cipher-1",
          expiresAt,
          generation: 1,
          expectedPreviousGeneration: 0,
          requireActiveLink: false,
          actor: "admin@example.com",
        })
        expect(stored).toBe(true)

        const afterGenerate = yield* settings.queryInvitationDetail(
          invitation.id,
        )
        expect(afterGenerate?.registrationLinkStatus).toBe(
          RegistrationLinkStatus.Active,
        )
        expect(afterGenerate?.registrationLinkGeneratedBy).toBe(
          "admin@example.com",
        )
        expect(
          afterGenerate?.registrationLinkExpiresAt?.getTime(),
        ).toBeGreaterThan(DateTime.toEpochMillis(now))
        // Julianday storage may lose sub-second precision.
        expect(
          Math.abs(
            (afterGenerate?.registrationLinkExpiresAt?.getTime() ?? 0) -
              expiresAt.getTime(),
          ),
        ).toBeLessThan(2000)

        const live = yield* settings.queryLiveRegistrationLink(
          invitation.id,
          DateTime.toDateUtc(now),
        )
        expect(live?.tokenHash).toBe("hash-token-1")
        expect(live?.ciphertext).toBe("cipher-1")

        const recorded = yield* settings.recordRegistrationLinkReveal(
          invitation.id,
          "admin@example.com",
          { tokenHash: "hash-token-1", generation: 1 },
        )
        expect(recorded).toBe(true)

        const afterReveal = yield* settings.queryInvitationDetail(invitation.id)
        expect(
          Math.abs(
            (afterReveal?.registrationLinkExpiresAt?.getTime() ?? 0) -
              (afterGenerate?.registrationLinkExpiresAt?.getTime() ?? 0),
          ),
        ).toBe(0)
        expect(afterReveal?.registrationLinkRevealedBy).toBe(
          "admin@example.com",
        )
        expect(afterReveal?.registrationLinkStatus).toBe(
          RegistrationLinkStatus.Active,
        )

        const rotatedExpiry = DateTime.toDateUtc(
          DateTime.add(DateTime.add(now, { days: 7 }), { hours: 1 }),
        )
        yield* settings.storeRegistrationLink(invitation.id, {
          tokenHash: "hash-token-2",
          encryptionVersion: 1,
          nonce: "nonce-2",
          authenticationTag: "tag-2",
          ciphertext: "cipher-2",
          expiresAt: rotatedExpiry,
          generation: 2,
          expectedPreviousGeneration: 1,
          requireActiveLink: true,
          actor: "admin@example.com",
        })

        const afterRotate = yield* settings.queryInvitationDetail(invitation.id)
        expect(afterRotate?.registrationLinkGeneration).toBe(2)
        expect(
          afterRotate?.registrationLinkExpiresAt?.getTime() ?? 0,
        ).toBeGreaterThan(
          afterGenerate?.registrationLinkExpiresAt?.getTime() ?? 0,
        )

        const liveAfterRotate = yield* settings.queryLiveRegistrationLink(
          invitation.id,
          DateTime.toDateUtc(now),
        )
        expect(liveAfterRotate?.tokenHash).toBe("hash-token-2")
        expect(liveAfterRotate?.tokenHash).not.toBe("hash-token-1")

        const revoked = yield* settings.revokeRegistrationLink(
          invitation.id,
          "admin@example.com",
        )
        expect(revoked).toBe(true)

        const afterRevoke = yield* settings.queryInvitationDetail(invitation.id)
        expect(afterRevoke?.status).toBe(InvitationLifecycleStatus.Pending)
        expect(afterRevoke?.email).toBe("link-lifecycle@example.com")
        expect(afterRevoke?.roles.length).toBe(1)
        expect(afterRevoke?.registrationLinkStatus).toBe(
          RegistrationLinkStatus.Revoked,
        )
        expect(afterRevoke?.registrationLinkRevokedBy).toBe("admin@example.com")

        const liveAfterRevoke = yield* settings.queryLiveRegistrationLink(
          invitation.id,
          DateTime.toDateUtc(now),
        )
        expect(liveAfterRevoke).toBeNull()
      }),
    )
  })

  it("reports expired when the live token clock has elapsed", async () => {
    await run(
      Effect.gen(function* () {
        const { invitation } = yield* seedPendingInvitation(
          "link-expired@example.com",
        )
        const settings = yield* SettingsQueries
        const past = new Date(Date.UTC(2020, 0, 1))

        yield* settings.storeRegistrationLink(invitation.id, {
          tokenHash: "hash-expired",
          encryptionVersion: 1,
          nonce: "nonce-e",
          authenticationTag: "tag-e",
          ciphertext: "cipher-e",
          expiresAt: past,
          generation: 1,
          expectedPreviousGeneration: 0,
          requireActiveLink: false,
          actor: "admin@example.com",
        })

        const db = yield* TypedSqliteDrizzle
        yield* db
          .update(schema.invitation)
          .set({
            registrationLinkExpiresAt: DateTime.unsafeMake(past),
          })
          .where(eq(schema.invitation.id, invitation.id))

        const detail = yield* settings.queryInvitationDetail(invitation.id)
        expect(detail?.registrationLinkStatus).toBe(
          RegistrationLinkStatus.Expired,
        )

        const live = yield* settings.queryLiveRegistrationLink(
          invitation.id,
          new Date(),
        )
        expect(live).toBeNull()
      }),
    )
  })

  it("detects passkey provider enablement", async () => {
    await run(
      Effect.gen(function* () {
        const settings = yield* SettingsQueries
        expect(yield* settings.isPasskeyProviderEnabled()).toBe(false)

        const db = yield* TypedSqliteDrizzle
        yield* db.insert(schema.oauthProvider).values({
          providerName: "passkey",
          providerConfig: {
            rpName: "Test",
            rpID: "localhost",
            origin: "http://localhost:3000",
          },
        })
        expect(yield* settings.isPasskeyProviderEnabled()).toBe(true)
      }),
    )
  })

  it("rejects concurrent generate when a live link already exists", async () => {
    await run(
      Effect.gen(function* () {
        const { invitation } = yield* seedPendingInvitation(
          "link-race@example.com",
        )
        const settings = yield* SettingsQueries
        const now = yield* DateTime.now
        const expiresAt = DateTime.toDateUtc(DateTime.add(now, { days: 7 }))

        expect(
          yield* settings.storeRegistrationLink(invitation.id, {
            tokenHash: "hash-race-1",
            encryptionVersion: 1,
            nonce: "nonce-r1",
            authenticationTag: "tag-r1",
            ciphertext: "cipher-r1",
            expiresAt,
            generation: 1,
            expectedPreviousGeneration: 0,
            requireActiveLink: false,
            actor: "admin@example.com",
          }),
        ).toBe(true)

        // Second generate with stale previous generation must not overwrite.
        expect(
          yield* settings.storeRegistrationLink(invitation.id, {
            tokenHash: "hash-race-2",
            encryptionVersion: 1,
            nonce: "nonce-r2",
            authenticationTag: "tag-r2",
            ciphertext: "cipher-r2",
            expiresAt,
            generation: 1,
            expectedPreviousGeneration: 0,
            requireActiveLink: false,
            actor: "admin@example.com",
          }),
        ).toBe(false)

        const live = yield* settings.queryLiveRegistrationLink(
          invitation.id,
          DateTime.toDateUtc(now),
        )
        expect(live?.tokenHash).toBe("hash-race-1")
      }),
    )
  })

  it("invalidates registration link material when the invitation is edited", async () => {
    await run(
      Effect.gen(function* () {
        const { invitation } = yield* seedPendingInvitation(
          "link-edit@example.com",
        )
        const settings = yield* SettingsQueries
        const now = yield* DateTime.now
        const expiresAt = DateTime.toDateUtc(DateTime.add(now, { days: 7 }))

        yield* settings.storeRegistrationLink(invitation.id, {
          tokenHash: "hash-edit",
          encryptionVersion: 1,
          nonce: "nonce-edit",
          authenticationTag: "tag-edit",
          ciphertext: "cipher-edit",
          expiresAt,
          generation: 1,
          expectedPreviousGeneration: 0,
          requireActiveLink: false,
          actor: "admin@example.com",
        })

        yield* settings.updateInvitationDetails(invitation.id, {
          email: "link-edited@example.com",
          updatedBy: "admin@example.com",
        })

        const detail = yield* settings.queryInvitationDetail(invitation.id)
        expect(detail?.email).toBe("link-edited@example.com")
        expect(detail?.registrationLinkStatus).toBe(
          RegistrationLinkStatus.Revoked,
        )
        const live = yield* settings.queryLiveRegistrationLink(
          invitation.id,
          DateTime.toDateUtc(now),
        )
        expect(live).toBeNull()
      }),
    )
  })

  it("keeps never-generated status when editing without a prior link", async () => {
    await run(
      Effect.gen(function* () {
        const { invitation } = yield* seedPendingInvitation(
          "link-never@example.com",
        )
        const settings = yield* SettingsQueries

        const before = yield* settings.queryInvitationDetail(invitation.id)
        expect(before?.registrationLinkStatus).toBe(
          RegistrationLinkStatus.NotGenerated,
        )

        yield* settings.updateInvitationDetails(invitation.id, {
          email: "link-never-edited@example.com",
          updatedBy: "admin@example.com",
        })

        const after = yield* settings.queryInvitationDetail(invitation.id)
        expect(after?.email).toBe("link-never-edited@example.com")
        expect(after?.registrationLinkStatus).toBe(
          RegistrationLinkStatus.NotGenerated,
        )
        expect(after?.registrationLinkRevokedAt).toBeNull()
      }),
    )
  })

  it("round-trips real AES-GCM material through store and queryLive", async () => {
    const secret = "test-invitation-registration-secret-for-links!!"
    const orgScope = "test-org"

    await run(
      Effect.gen(function* () {
        const { invitation } = yield* seedPendingInvitation(
          "link-crypto@example.com",
        )
        const settings = yield* SettingsQueries
        const now = yield* DateTime.now
        const expiresAt = new Date(
          Math.round(
            DateTime.toEpochMillis(DateTime.add(now, { days: 7 })) / 1000,
          ) * 1000,
        )

        const material = yield* generateRegistrationLinkMaterial({
          organisationScope: orgScope,
          invitationId: invitation.id,
          expiresAtUnixMs: expiresAt.getTime(),
          secret,
        }).pipe(Effect.orDie)

        expect(
          yield* settings.storeRegistrationLink(invitation.id, {
            tokenHash: material.tokenHash,
            encryptionVersion: material.envelope.encryptionVersion,
            nonce: material.envelope.nonce,
            authenticationTag: material.envelope.authenticationTag,
            ciphertext: material.envelope.ciphertext,
            expiresAt,
            generation: 1,
            expectedPreviousGeneration: 0,
            requireActiveLink: false,
            actor: "admin@example.com",
          }),
        ).toBe(true)

        const live = yield* settings.queryLiveRegistrationLink(
          invitation.id,
          DateTime.toDateUtc(now),
        )
        expect(live).not.toBeNull()
        if (!live) {
          return
        }

        const revealed = yield* decryptRegistrationLinkToken({
          organisationScope: orgScope,
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
        }).pipe(Effect.orDie)

        expect(revealed).toBe(material.rawToken)

        const afterReveal = yield* settings.recordRegistrationLinkReveal(
          invitation.id,
          "admin@example.com",
          { tokenHash: live.tokenHash, generation: live.generation },
        )
        expect(afterReveal).toBe(true)
        const detail = yield* settings.queryInvitationDetail(invitation.id)
        expect(detail?.registrationLinkExpiresAt?.getTime()).toBe(
          live.expiresAt.getTime(),
        )
      }),
    )
  })

  it("pinned revoke does not clear a newer concurrent generation", async () => {
    await run(
      Effect.gen(function* () {
        const { invitation } = yield* seedPendingInvitation(
          "link-pin-revoke@example.com",
        )
        const settings = yield* SettingsQueries
        const now = yield* DateTime.now
        const expiresAt = DateTime.toDateUtc(DateTime.add(now, { days: 7 }))

        yield* settings.storeRegistrationLink(invitation.id, {
          tokenHash: "hash-gen1",
          encryptionVersion: 1,
          nonce: "nonce-g1",
          authenticationTag: "tag-g1",
          ciphertext: "cipher-g1",
          expiresAt,
          generation: 1,
          expectedPreviousGeneration: 0,
          requireActiveLink: false,
          actor: "admin@example.com",
        })

        yield* settings.storeRegistrationLink(invitation.id, {
          tokenHash: "hash-gen2",
          encryptionVersion: 1,
          nonce: "nonce-g2",
          authenticationTag: "tag-g2",
          ciphertext: "cipher-g2",
          expiresAt,
          generation: 2,
          expectedPreviousGeneration: 1,
          requireActiveLink: true,
          actor: "admin@example.com",
        })

        // Stale ensure pin for generation 1 must not clear generation 2.
        expect(
          yield* settings.revokeRegistrationLink(
            invitation.id,
            "admin@example.com",
            { tokenHash: "hash-gen1", generation: 1 },
          ),
        ).toBe(false)

        const live = yield* settings.queryLiveRegistrationLink(
          invitation.id,
          DateTime.toDateUtc(now),
        )
        expect(live?.tokenHash).toBe("hash-gen2")
        expect(live?.generation).toBe(2)
      }),
    )
  })

  it("rejects reveal pin after concurrent rotate", async () => {
    await run(
      Effect.gen(function* () {
        const { invitation } = yield* seedPendingInvitation(
          "link-reveal-race@example.com",
        )
        const settings = yield* SettingsQueries
        const now = yield* DateTime.now
        const expiresAt = DateTime.toDateUtc(DateTime.add(now, { days: 7 }))

        yield* settings.storeRegistrationLink(invitation.id, {
          tokenHash: "hash-old",
          encryptionVersion: 1,
          nonce: "nonce-old",
          authenticationTag: "tag-old",
          ciphertext: "cipher-old",
          expiresAt,
          generation: 1,
          expectedPreviousGeneration: 0,
          requireActiveLink: false,
          actor: "admin@example.com",
        })

        // Concurrent rotate replaces the live generation.
        yield* settings.storeRegistrationLink(invitation.id, {
          tokenHash: "hash-new",
          encryptionVersion: 1,
          nonce: "nonce-new",
          authenticationTag: "tag-new",
          ciphertext: "cipher-new",
          expiresAt,
          generation: 2,
          expectedPreviousGeneration: 1,
          requireActiveLink: true,
          actor: "admin@example.com",
        })

        // Stale reveal pin for generation 1 must fail.
        expect(
          yield* settings.recordRegistrationLinkReveal(
            invitation.id,
            "admin@example.com",
            { tokenHash: "hash-old", generation: 1 },
          ),
        ).toBe(false)

        // Pin for current generation still works.
        expect(
          yield* settings.recordRegistrationLinkReveal(
            invitation.id,
            "admin@example.com",
            { tokenHash: "hash-new", generation: 2 },
          ),
        ).toBe(true)
      }),
    )
  })

  it("does not revoke a live link when email is unchanged on edit", async () => {
    await run(
      Effect.gen(function* () {
        const email = "link-noop-edit@example.com"
        const { invitation } = yield* seedPendingInvitation(email)
        const settings = yield* SettingsQueries
        const now = yield* DateTime.now
        const expiresAt = DateTime.toDateUtc(DateTime.add(now, { days: 7 }))

        yield* settings.storeRegistrationLink(invitation.id, {
          tokenHash: "hash-noop",
          encryptionVersion: 1,
          nonce: "nonce-noop",
          authenticationTag: "tag-noop",
          ciphertext: "cipher-noop",
          expiresAt,
          generation: 1,
          expectedPreviousGeneration: 0,
          requireActiveLink: false,
          actor: "admin@example.com",
        })

        yield* settings.updateInvitationDetails(invitation.id, {
          email,
          updatedBy: "admin@example.com",
        })

        const detail = yield* settings.queryInvitationDetail(invitation.id)
        expect(detail?.registrationLinkStatus).toBe(
          RegistrationLinkStatus.Active,
        )
        const live = yield* settings.queryLiveRegistrationLink(
          invitation.id,
          DateTime.toDateUtc(now),
        )
        expect(live?.tokenHash).toBe("hash-noop")
      }),
    )
  })

  it("revokes a live link when roles change without an email change", async () => {
    await run(
      Effect.gen(function* () {
        const { invitation, role, org } = yield* seedPendingInvitation(
          "link-role-change@example.com",
        )
        const settings = yield* SettingsQueries
        const db = yield* TypedSqliteDrizzle
        const now = yield* DateTime.now
        const expiresAt = DateTime.toDateUtc(DateTime.add(now, { days: 7 }))

        const [extraRole] = yield* db
          .insert(schema.role)
          .values({
            name: "Manager",
            orgUnitId: org.id,
            path: "/Manager",
          })
          .returning()
        if (!extraRole) throw new Error("extra role")

        yield* settings.storeRegistrationLink(invitation.id, {
          tokenHash: "hash-role",
          encryptionVersion: 1,
          nonce: "nonce-role",
          authenticationTag: "tag-role",
          ciphertext: "cipher-role",
          expiresAt,
          generation: 1,
          expectedPreviousGeneration: 0,
          requireActiveLink: false,
          actor: "admin@example.com",
        })

        yield* settings.replaceInvitationRoles(
          invitation.id,
          [role.id, extraRole.id],
          "admin@example.com",
        )

        const detail = yield* settings.queryInvitationDetail(invitation.id)
        expect(detail?.registrationLinkStatus).toBe(
          RegistrationLinkStatus.Revoked,
        )
        expect(
          yield* settings.queryLiveRegistrationLink(
            invitation.id,
            DateTime.toDateUtc(now),
          ),
        ).toBeNull()
      }),
    )
  })
})
