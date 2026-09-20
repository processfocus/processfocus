import { SqlClient } from "@effect/sql"
import { and, eq, inArray } from "drizzle-orm"
import { Cause, DateTime, Effect, Exit, FiberRef, Layer, Option } from "effect"
import {
  type AuthenticationDatabase,
  InviteRequiredError,
  ProviderUserEmailAlreadyOwnedError,
  findOrCreateProviderUserFromVerifiedIdentity,
} from "@pf/auth-api"
import * as schema from "@pf/drizzle-sqlite"
import {
  InvitationLifecycleStatus,
  InvitationSource,
  ProviderUserQueries,
  SettingsQueries,
} from "@pf/graphql-db-operations"
import type {
  NormalizedEmail,
  VerifiedHumanIdentity,
} from "@pf/openauth/provider/provider"
import { DbOperations } from "@pf/org-to-db"
import { RequestTime } from "@pf/request-time"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite"
import { DatabaseTest } from "@pf/service-drizzle-sqlite/test"
import { SqliteAuthenticationDatabaseLive } from "../src/lib/authentication-database.js"
import { SqliteDbOperationsLive } from "../src/lib/org-to-db.js"
import { SqliteProviderUserQueriesLive } from "../src/lib/query-provider-user.js"
import { SqliteSettingsQueriesLive } from "../src/lib/settings-queries.js"
import { describe, expect, it } from "bun:test"

const identityFor = (
  email: string,
  subject: string,
): VerifiedHumanIdentity => ({
  type: "verified-human-identity",
  provider: "google",
  subject,
  email: email as NormalizedEmail,
  profile: {
    name: "Test User",
    givenName: "Test",
    familyName: "User",
    picture: "",
    locale: "en",
  },
  emailVerification: {
    method: "oidc-claim",
    claim: "email_verified",
    verified: true,
  },
})

const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | TypedSqliteDrizzle
    | SettingsQueries
    | AuthenticationDatabase
    | SqlClient.SqlClient
  >,
) =>
  Effect.runPromise(
    Effect.provide(
      Effect.provide(
        Effect.provide(effect, SqliteAuthenticationDatabaseLive),
        SqliteSettingsQueriesLive,
      ),
      DatabaseTest,
    ),
  )

describe("invitation lifecycle", () => {
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
        providerName: "google",
        providerConfig: {
          clientID: "client",
          clientSecret: "secret",
          scopes: ["openid", "email", "profile"],
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

  it("defaults invited users list to pending and can filter accepted history", async () => {
    await run(
      Effect.gen(function* () {
        const email = "lifecycle@example.com"
        const { invitation } = yield* seedPendingInvitation(email)
        const settings = yield* SettingsQueries

        const pendingBefore = yield* settings.queryAllInvitations(1, 20)
        expect(pendingBefore.totalCount).toBe(1)
        expect(pendingBefore.items[0]?.id).toBe(invitation.id)
        expect(pendingBefore.items[0]?.status).toBe(
          InvitationLifecycleStatus.Pending,
        )

        yield* findOrCreateProviderUserFromVerifiedIdentity(
          identityFor(email, "subject-1"),
        )

        const pendingAfter = yield* settings.queryAllInvitations(1, 20)
        expect(pendingAfter.totalCount).toBe(0)

        const accepted = yield* settings.queryAllInvitations(
          1,
          20,
          InvitationLifecycleStatus.Accepted,
        )
        expect(accepted.totalCount).toBe(1)
        expect(accepted.items[0]?.status).toBe(
          InvitationLifecycleStatus.Accepted,
        )
        expect(accepted.items[0]?.acceptedByProvider).toBe("google")
        expect(accepted.items[0]?.acceptedBySubject).toBe("subject-1")
        expect(accepted.items[0]?.acceptedAt).toBeInstanceOf(Date)
      }),
    )
  })

  it("rejects ordinary delete of an accepted invitation", async () => {
    await run(
      Effect.gen(function* () {
        const email = "accepted-delete@example.com"
        const { invitation } = yield* seedPendingInvitation(email)
        yield* findOrCreateProviderUserFromVerifiedIdentity(
          identityFor(email, "subject-delete"),
        )
        const settings = yield* SettingsQueries
        const deleted = yield* settings.deleteInvitation(
          invitation.id,
          "tester",
        )
        expect(deleted).toBe(false)

        const detail = yield* settings.queryInvitationDetail(invitation.id)
        expect(detail?.status).toBe(InvitationLifecycleStatus.Accepted)
      }),
    )
  })

  it("creates a new pending invitation without mutating accepted history", async () => {
    await run(
      Effect.gen(function* () {
        const email = "reinvite@example.com"
        const { invitation } = yield* seedPendingInvitation(email)
        const providerUser =
          yield* findOrCreateProviderUserFromVerifiedIdentity(
            identityFor(email, "subject-reinvite"),
          )
        const db = yield* TypedSqliteDrizzle
        const settings = yield* SettingsQueries

        const first = yield* settings.queryInvitationDetail(invitation.id)
        expect(first?.status).toBe(InvitationLifecycleStatus.Accepted)

        yield* db
          .update(schema.providerUser)
          .set({ _deleted: true })
          .where(eq(schema.providerUser.userId, providerUser.id))
        yield* db
          .update(schema.user)
          .set({ _deleted: true })
          .where(eq(schema.user.id, providerUser.id))

        const newId = yield* settings.createInvitation({
          invitationId: "reinvite-2",
          email,
          source: InvitationSource.Dashboard,
          createdBy: "tester",
          updatedBy: "tester",
        })
        const pending = yield* settings.queryPendingInvitationByEmail(email)
        expect(pending?.id).toBe(newId)
        expect(pending?.status).toBe(InvitationLifecycleStatus.Pending)

        const acceptedHistory = yield* settings.queryInvitationDetail(
          invitation.id,
        )
        expect(acceptedHistory?.status).toBe(InvitationLifecycleStatus.Accepted)
        expect(acceptedHistory?.id).not.toBe(newId)
      }),
    )
  })

  it("ensures concurrent acceptance leaves one provider user and accepted invitation", async () => {
    await run(
      Effect.gen(function* () {
        const email = "race@example.com"
        yield* seedPendingInvitation(email)
        const sql = yield* SqlClient.SqlClient

        // Match production auth success: create + roles + accept share one txn.
        const acceptInTransaction = (
          identity: {
            readonly subject: string
            readonly email: NormalizedEmail
          } & VerifiedHumanIdentity,
        ) =>
          sql.withTransaction(
            findOrCreateProviderUserFromVerifiedIdentity(identity),
          )

        const results = yield* Effect.all(
          [
            Effect.exit(acceptInTransaction(identityFor(email, "subject-a"))),
            Effect.exit(acceptInTransaction(identityFor(email, "subject-b"))),
          ],
          { concurrency: 2 },
        )

        const successes = results.filter((result) => Exit.isSuccess(result))
        const failures = results.filter((result) => Exit.isFailure(result))
        expect(successes).toHaveLength(1)
        expect(failures).toHaveLength(1)
        expect(results).toHaveLength(2)

        if (Exit.isFailure(failures[0]!)) {
          const error = Cause.failureOption(failures[0]!.cause)
          // Prefer typed domain failures; unique-index races may still surface as
          // untyped SQL failures depending on Effect SQL wrapping.
          if (Option.isSome(error)) {
            const typed =
              error.value instanceof ProviderUserEmailAlreadyOwnedError ||
              error.value instanceof InviteRequiredError
            if (!typed) {
              // Still acceptable if the durable state assertions below hold.
              expect(String(error.value)).toBeTruthy()
            }
          }
        }

        const db = yield* TypedSqliteDrizzle
        const providerUsers = yield* db
          .select({
            id: schema.providerUser.id,
            userId: schema.providerUser.userId,
          })
          .from(schema.providerUser)
          .where(
            and(
              eq(schema.providerUser.email, email),
              eq(schema.providerUser._deleted, false),
            ),
          )
        expect(providerUsers).toHaveLength(1)

        // Rolled-back loser must leave no orphan user rows for either subject.
        const raceUsers = yield* db
          .select({
            id: schema.user.id,
            sub: schema.user.sub,
            providerUserId: schema.providerUser.id,
          })
          .from(schema.user)
          .leftJoin(
            schema.providerUser,
            eq(schema.providerUser.userId, schema.user.id),
          )
          .where(
            and(
              eq(schema.user.provider, "google"),
              inArray(schema.user.sub, ["subject-a", "subject-b"]),
            ),
          )
        expect(raceUsers).toHaveLength(1)
        expect(raceUsers[0]?.providerUserId).toBe(providerUsers[0]?.id)
        expect(raceUsers.every((row) => row.providerUserId !== null)).toBe(true)

        const invitations = yield* db
          .select({
            status: schema.invitation.invitationStatus,
            pending: schema.invitation.invitationPendingEmail,
          })
          .from(schema.invitation)
          .where(eq(schema.invitation.email, email))
        expect(invitations).toHaveLength(1)
        expect(invitations[0]?.status).toBe("accepted")
        expect(invitations[0]?.pending).toBeNull()
      }),
    )
  })

  it("M2M acceptPendingInvitationForProviderUser is single-winner and retryable on miss", async () => {
    const runM2m = <A, E>(
      test: Effect.Effect<
        A,
        E,
        TypedSqliteDrizzle | ProviderUserQueries | SqlClient.SqlClient
      >,
    ): Promise<A> =>
      Effect.runPromise(
        Effect.provide(
          Effect.provide(test, SqliteProviderUserQueriesLive),
          DatabaseTest,
        ),
      )

    await runM2m(
      Effect.gen(function* () {
        const email = "m2m-race@example.com"
        const db = yield* TypedSqliteDrizzle
        const sql = yield* SqlClient.SqlClient
        const providerUsers = yield* ProviderUserQueries

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

        const [invitation] = yield* db
          .insert(schema.invitation)
          .values({
            invitationId: "m2m-invite",
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

        // Same durable accept primitive used by requestProviderUserPermissions.
        const created = yield* sql.withTransaction(
          Effect.gen(function* () {
            const row = yield* providerUsers.createProviderUserFromInvitation({
              email,
              orgUnitId: org.id,
            })
            const accepted =
              yield* providerUsers.acceptPendingInvitationForProviderUser({
                email,
                providerUserId: row.providerUserId,
                provider: "m2m",
                subject: `m2m:${email}`,
              })
            expect(accepted).toBe(true)
            return row
          }),
        )

        // Conditional accept is single-winner: a second attempt is a miss.
        const secondAccept =
          yield* providerUsers.acceptPendingInvitationForProviderUser({
            email,
            providerUserId: created.providerUserId,
            provider: "m2m",
            subject: "m2m-subject-retry",
          })
        expect(secondAccept).toBe(false)

        const [invitationAfter] = yield* db
          .select({
            status: schema.invitation.invitationStatus,
            pending: schema.invitation.invitationPendingEmail,
            acceptedBy: schema.invitation.acceptedByProviderUserId,
          })
          .from(schema.invitation)
          .where(eq(schema.invitation.id, invitation.id))
          .limit(1)
        expect(invitationAfter?.status).toBe("accepted")
        expect(invitationAfter?.pending).toBeNull()
        expect(invitationAfter?.acceptedBy).toBe(created.providerUserId)

        const activeProviderUsers = yield* db
          .select({ id: schema.providerUser.id })
          .from(schema.providerUser)
          .where(
            and(
              eq(schema.providerUser.email, email),
              eq(schema.providerUser._deleted, false),
            ),
          )
        expect(activeProviderUsers).toHaveLength(1)
      }),
    )
  })

  it("does not soft-delete a later re-invite when rehydrating accepted model history", async () => {
    const RequestTimeTest = Layer.succeed(
      RequestTime,
      FiberRef.unsafeMake(DateTime.unsafeMake(Date.now())),
    )
    const rehydrateLayer = Layer.mergeAll(
      SqliteDbOperationsLive,
      RequestTimeTest,
      DatabaseTest,
    )
    type RehydrateRequirements = Layer.Layer.Success<typeof rehydrateLayer>
    const runRehydrate = <A, E>(
      test: Effect.Effect<A, E, RehydrateRequirements>,
    ): Promise<A> => Effect.runPromise(Effect.provide(test, rehydrateLayer))

    await runRehydrate(
      Effect.gen(function* () {
        const email = "rehydrate@example.com"
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

        // Accepted model-owned invitation history.
        yield* db.insert(schema.invitation).values({
          invitationId: "model-invite",
          email,
          invitationStatus: InvitationLifecycleStatus.Accepted,
          invitationSource: InvitationSource.Model,
          invitationPendingEmail: null,
        })

        // Later dashboard re-invite for the same email after offboarding.
        const [reinvite] = yield* db
          .insert(schema.invitation)
          .values({
            invitationId: "dashboard-reinvite",
            email,
            invitationStatus: InvitationLifecycleStatus.Pending,
            invitationSource: InvitationSource.Dashboard,
            invitationPendingEmail: email,
          })
          .returning()
        if (!reinvite) throw new Error("reinvite")

        const ops = yield* DbOperations
        // Rehydrate the accepted model construct must leave the re-invite intact.
        yield* ops.upsertInvitation({ id: "model-invite", email }, [])

        const [reinviteAfter] = yield* db
          .select({
            id: schema.invitation.id,
            status: schema.invitation.invitationStatus,
            pending: schema.invitation.invitationPendingEmail,
            deleted: schema.invitation._deleted,
          })
          .from(schema.invitation)
          .where(eq(schema.invitation.id, reinvite.id))
          .limit(1)

        expect(reinviteAfter?.deleted).toBe(false)
        expect(reinviteAfter?.status).toBe(InvitationLifecycleStatus.Pending)
        expect(reinviteAfter?.pending).toBe(email)
      }),
    )
  })

  it("still requires an invitation when no pending grant exists", async () => {
    await run(
      Effect.gen(function* () {
        yield* seedPendingInvitation("someone-else@example.com")
        const result = yield* Effect.exit(
          findOrCreateProviderUserFromVerifiedIdentity(
            identityFor("missing@example.com", "missing-sub"),
          ),
        )
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) {
          const error = Cause.failureOption(result.cause)
          expect(Option.isSome(error)).toBe(true)
          if (Option.isSome(error)) {
            expect(error.value).toBeInstanceOf(InviteRequiredError)
          }
        }
      }),
    )
  })

  it("keeps invitation pending when email is already owned by another provider", async () => {
    await run(
      Effect.gen(function* () {
        const email = "owned@example.com"
        const { org, invitation } = yield* seedPendingInvitation(email)
        const db = yield* TypedSqliteDrizzle

        const [user] = yield* db
          .insert(schema.user)
          .values({
            provider: "github",
            sub: "github-existing",
            lastLoggedIn: DateTime.unsafeMake(Date.now()),
          })
          .returning()
        if (!user) throw new Error("user")
        yield* db.insert(schema.providerUser).values({
          userId: user.id,
          email,
          name: "Owned",
          firstName: "Owned",
          lastName: "User",
          picture: "",
          locale: "en",
          orgUnitId: org.id,
        })

        const result = yield* Effect.exit(
          findOrCreateProviderUserFromVerifiedIdentity(
            identityFor(email, "google-new"),
          ),
        )
        expect(Exit.isFailure(result)).toBe(true)

        const [stillPending] = yield* db
          .select({
            status: schema.invitation.invitationStatus,
            pendingEmail: schema.invitation.invitationPendingEmail,
          })
          .from(schema.invitation)
          .where(eq(schema.invitation.id, invitation.id))
          .limit(1)
        expect(stillPending?.status).toBe("pending")
        expect(stillPending?.pendingEmail).toBe(email)
      }),
    )
  })
})
