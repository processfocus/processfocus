// biome-ignore-all lint/style/noNonNullAssertion: test assertions

import { expect, it } from "@effect/vitest"
import { and, eq } from "drizzle-orm"
import { DateTime, Effect, FiberRef, Layer } from "effect"
import * as schema from "@pf/drizzle-postgres"
import {
  InvitationLifecycleStatus,
  InvitationSource,
} from "@pf/graphql-db-operations"
import { storeOrganisation } from "@pf/org-to-db"
import { Invitation, Organisation, Role } from "@pf/process"
import { RequestTime } from "@pf/request-time"
import { TypedPostgresDrizzle } from "@pf/service-drizzle-postgres"
import { PostgresDbOperationsLive } from "../src/lib/org-to-db"
import { PostgresTest } from "./postgres-test"

const TestLayer = Layer.mergeAll(
  PostgresTest,
  PostgresDbOperationsLive,
  Layer.succeed(
    RequestTime,
    FiberRef.unsafeMake(DateTime.unsafeMake(Date.now())),
  ),
)

const makeOrgWithInvitations = (
  invitations: ReadonlyArray<{
    id: string
    email: string
    roleIds: readonly string[]
  }>,
) => {
  const organisation = new Organisation({ name: "Hydration Org" })
  const rolesById = new Map<string, Role>()
  const ensureRole = (roleId: string) => {
    const existing = rolesById.get(roleId)
    if (existing) return existing
    const role = new Role(organisation, roleId, { name: roleId })
    rolesById.set(roleId, role)
    return role
  }

  for (const invitation of invitations) {
    new Invitation(organisation, invitation.id, {
      email: invitation.email,
      roles: invitation.roleIds.map(ensureRole),
    })
  }

  return organisation
}

const activeInvitationRoles = (invitationPk: string) =>
  Effect.gen(function* () {
    const db = yield* TypedPostgresDrizzle
    return yield* db
      .select({
        rolePath: schema.role.path,
        deleted: schema.invitationRole._deleted,
      })
      .from(schema.invitationRole)
      .innerJoin(schema.role, eq(schema.invitationRole.roleId, schema.role.id))
      .where(
        and(
          eq(schema.invitationRole.invitationId, invitationPk),
          eq(schema.invitationRole._deleted, false),
        ),
      )
  })

const invitationByConstructId = (constructId: string) =>
  Effect.gen(function* () {
    const db = yield* TypedPostgresDrizzle
    return yield* db
      .select()
      .from(schema.invitation)
      .where(eq(schema.invitation.invitationId, constructId))
  })

const seedNonModelInvitation = (input: {
  invitationId: string
  email: string
  source: (typeof InvitationSource)[keyof typeof InvitationSource]
  roleId: string
  status?: (typeof InvitationLifecycleStatus)[keyof typeof InvitationLifecycleStatus]
}) =>
  Effect.gen(function* () {
    const db = yield* TypedPostgresDrizzle
    const status = input.status ?? InvitationLifecycleStatus.Pending
    const [invitation] = yield* db
      .insert(schema.invitation)
      .values({
        invitationId: input.invitationId,
        email: input.email,
        invitationStatus: status,
        invitationSource: input.source,
        invitationPendingEmail:
          status === InvitationLifecycleStatus.Pending ? input.email : null,
      })
      .returning()
    if (!invitation) throw new Error("invitation")

    yield* db.insert(schema.invitationRole).values({
      invitationId: invitation.id,
      roleId: input.roleId,
    })

    return invitation
  })

it.layer(TestLayer, { timeout: "60 seconds" })(
  "authored invitation hydration",
  (it) => {
    it.effect(
      "adds pending model invitations with roles and source=model",
      () =>
        Effect.gen(function* () {
          yield* storeOrganisation(
            makeOrgWithInvitations([
              {
                id: "admin-invite",
                email: "admin@example.com",
                roleIds: ["admin"],
              },
            ]),
          )

          const rows = yield* invitationByConstructId("admin-invite")
          expect(rows).toHaveLength(1)
          expect(rows[0]!._deleted).toBe(false)
          expect(rows[0]!.invitationStatus).toBe(
            InvitationLifecycleStatus.Pending,
          )
          expect(rows[0]!.invitationSource).toBe(InvitationSource.Model)
          expect(rows[0]!.email).toBe("admin@example.com")
          expect(rows[0]!.invitationPendingEmail).toBe("admin@example.com")

          const roles = yield* activeInvitationRoles(rows[0]!.id)
          expect(roles.map((r) => r.rolePath)).toEqual(["/admin"])
        }),
    )

    it.effect(
      "soft-deletes removed pending model invitations and their roles in one hydrate",
      () =>
        Effect.gen(function* () {
          yield* storeOrganisation(
            makeOrgWithInvitations([
              {
                id: "stale-invite",
                email: "stale@example.com",
                roleIds: ["admin"],
              },
              {
                id: "kept-invite",
                email: "kept@example.com",
                roleIds: ["member"],
              },
            ]),
          )

          yield* storeOrganisation(
            makeOrgWithInvitations([
              {
                id: "kept-invite",
                email: "kept@example.com",
                roleIds: ["member"],
              },
            ]),
          )

          const stale = yield* invitationByConstructId("stale-invite")
          expect(stale).toHaveLength(1)
          expect(stale[0]!._deleted).toBe(true)
          expect(stale[0]!.invitationPendingEmail).toBeNull()
          expect(stale[0]!.invitationStatus).toBe(
            InvitationLifecycleStatus.Pending,
          )

          const db = yield* TypedPostgresDrizzle
          const staleRoles = yield* db
            .select()
            .from(schema.invitationRole)
            .where(eq(schema.invitationRole.invitationId, stale[0]!.id))
          expect(staleRoles.length).toBeGreaterThan(0)
          expect(staleRoles.every((row) => row._deleted)).toBe(true)

          const kept = yield* invitationByConstructId("kept-invite")
          expect(kept[0]!._deleted).toBe(false)
          const keptRoles = yield* activeInvitationRoles(kept[0]!.id)
          expect(keptRoles.map((r) => r.rolePath)).toEqual(["/member"])
        }),
    )

    it.effect("updates pending model invitation email and roles on edit", () =>
      Effect.gen(function* () {
        yield* storeOrganisation(
          makeOrgWithInvitations([
            {
              id: "edit-me",
              email: "before@example.com",
              roleIds: ["admin", "member"],
            },
          ]),
        )

        yield* storeOrganisation(
          makeOrgWithInvitations([
            {
              id: "edit-me",
              email: "after@example.com",
              roleIds: ["member"],
            },
          ]),
        )

        const rows = yield* invitationByConstructId("edit-me")
        expect(rows).toHaveLength(1)
        expect(rows[0]!._deleted).toBe(false)
        expect(rows[0]!.email).toBe("after@example.com")
        expect(rows[0]!.invitationPendingEmail).toBe("after@example.com")
        expect(rows[0]!.invitationSource).toBe(InvitationSource.Model)

        const activeRoles = yield* activeInvitationRoles(rows[0]!.id)
        expect(activeRoles.map((r) => r.rolePath).sort()).toEqual(["/member"])

        const db = yield* TypedPostgresDrizzle
        const allRoles = yield* db
          .select({
            path: schema.role.path,
            deleted: schema.invitationRole._deleted,
          })
          .from(schema.invitationRole)
          .innerJoin(
            schema.role,
            eq(schema.invitationRole.roleId, schema.role.id),
          )
          .where(eq(schema.invitationRole.invitationId, rows[0]!.id))
        expect(allRoles.find((r) => r.path === "/admin")?.deleted).toBe(true)
      }),
    )

    it.effect(
      "does not rewrite, delete, or reopen accepted model invitations on remove or change",
      () =>
        Effect.gen(function* () {
          yield* storeOrganisation(
            makeOrgWithInvitations([
              {
                id: "accepted-invite",
                email: "accepted@example.com",
                roleIds: ["admin"],
              },
            ]),
          )

          const db = yield* TypedPostgresDrizzle
          yield* db
            .update(schema.invitation)
            .set({
              invitationStatus: InvitationLifecycleStatus.Accepted,
              invitationPendingEmail: null,
              invitationAcceptedAt: DateTime.unsafeMake(Date.now()),
              invitationAcceptedByProvider: "google",
              invitationAcceptedBySubject: "sub-1",
            })
            .where(eq(schema.invitation.invitationId, "accepted-invite"))

          yield* storeOrganisation(
            makeOrgWithInvitations([
              {
                id: "accepted-invite",
                email: "changed@example.com",
                roleIds: ["member"],
              },
            ]),
          )

          const afterChange = yield* invitationByConstructId("accepted-invite")
          expect(afterChange).toHaveLength(1)
          expect(afterChange[0]!._deleted).toBe(false)
          expect(afterChange[0]!.invitationStatus).toBe(
            InvitationLifecycleStatus.Accepted,
          )
          expect(afterChange[0]!.email).toBe("accepted@example.com")
          expect(afterChange[0]!.invitationPendingEmail).toBeNull()
          const rolesAfterChange = yield* activeInvitationRoles(
            afterChange[0]!.id,
          )
          expect(rolesAfterChange.map((r) => r.rolePath)).toEqual(["/admin"])

          yield* storeOrganisation(makeOrgWithInvitations([]))

          const afterRemove = yield* invitationByConstructId("accepted-invite")
          expect(afterRemove).toHaveLength(1)
          expect(afterRemove[0]!._deleted).toBe(false)
          expect(afterRemove[0]!.invitationStatus).toBe(
            InvitationLifecycleStatus.Accepted,
          )
          expect(afterRemove[0]!.email).toBe("accepted@example.com")
        }),
    )

    it.effect(
      "does not soft-delete legacy-closed model invitations when omitted from the model",
      () =>
        Effect.gen(function* () {
          yield* storeOrganisation(
            makeOrgWithInvitations([
              {
                id: "legacy-closed-invite",
                email: "legacy-closed@example.com",
                roleIds: ["admin"],
              },
            ]),
          )

          const db = yield* TypedPostgresDrizzle
          yield* db
            .update(schema.invitation)
            .set({
              invitationStatus: InvitationLifecycleStatus.LegacyClosed,
              invitationPendingEmail: null,
              invitationLegacyClosedAt: DateTime.unsafeMake(Date.now()),
              invitationLegacyClosureReason: "preexisting_provider_user",
            })
            .where(eq(schema.invitation.invitationId, "legacy-closed-invite"))

          yield* storeOrganisation(makeOrgWithInvitations([]))

          const rows = yield* invitationByConstructId("legacy-closed-invite")
          expect(rows).toHaveLength(1)
          expect(rows[0]!._deleted).toBe(false)
          expect(rows[0]!.invitationStatus).toBe(
            InvitationLifecycleStatus.LegacyClosed,
          )
          expect(rows[0]!.invitationSource).toBe(InvitationSource.Model)
          expect(rows[0]!.email).toBe("legacy-closed@example.com")
          expect(rows[0]!.invitationPendingEmail).toBeNull()
        }),
    )

    it.effect(
      "requires a new construct identity for another grant after acceptance",
      () =>
        Effect.gen(function* () {
          yield* storeOrganisation(
            makeOrgWithInvitations([
              {
                id: "first-grant",
                email: "repeat@example.com",
                roleIds: ["admin"],
              },
            ]),
          )

          const db = yield* TypedPostgresDrizzle
          yield* db
            .update(schema.invitation)
            .set({
              invitationStatus: InvitationLifecycleStatus.Accepted,
              invitationPendingEmail: null,
              invitationAcceptedAt: DateTime.unsafeMake(Date.now()),
              invitationAcceptedByProvider: "google",
              invitationAcceptedBySubject: "sub-repeat",
            })
            .where(eq(schema.invitation.invitationId, "first-grant"))

          yield* storeOrganisation(
            makeOrgWithInvitations([
              {
                id: "second-grant",
                email: "repeat@example.com",
                roleIds: ["member"],
              },
            ]),
          )

          const first = yield* invitationByConstructId("first-grant")
          const second = yield* invitationByConstructId("second-grant")
          expect(first[0]!._deleted).toBe(false)
          expect(first[0]!.invitationStatus).toBe(
            InvitationLifecycleStatus.Accepted,
          )
          expect(second[0]!._deleted).toBe(false)
          expect(second[0]!.invitationStatus).toBe(
            InvitationLifecycleStatus.Pending,
          )
          expect(second[0]!.invitationSource).toBe(InvitationSource.Model)
          expect(second[0]!.id).not.toBe(first[0]!.id)
          const secondRoles = yield* activeInvitationRoles(second[0]!.id)
          expect(secondRoles.map((r) => r.rolePath)).toEqual(["/member"])
        }),
    )

    it.effect(
      "leaves dashboard, process, and legacy invitations alone during model orphan cleanup",
      () =>
        Effect.gen(function* () {
          yield* storeOrganisation(
            makeOrgWithInvitations([
              {
                id: "model-only",
                email: "model@example.com",
                roleIds: ["admin"],
              },
            ]),
          )

          const db = yield* TypedPostgresDrizzle
          const roles = yield* db
            .select()
            .from(schema.role)
            .where(
              and(
                eq(schema.role.path, "/admin"),
                eq(schema.role._deleted, false),
              ),
            )
            .limit(1)
          const adminRole = roles[0]
          if (!adminRole) throw new Error("admin role missing")

          yield* seedNonModelInvitation({
            invitationId: "dash-invite",
            email: "dashboard@example.com",
            source: InvitationSource.Dashboard,
            roleId: adminRole.id,
          })
          yield* seedNonModelInvitation({
            invitationId: "proc-invite",
            email: "process@example.com",
            source: InvitationSource.Process,
            roleId: adminRole.id,
          })
          yield* seedNonModelInvitation({
            invitationId: "legacy-invite",
            email: "legacy@example.com",
            source: InvitationSource.Legacy,
            roleId: adminRole.id,
          })

          yield* storeOrganisation(
            makeOrgWithInvitations([
              {
                id: "retained-model",
                email: "retained@example.com",
                roleIds: ["admin"],
              },
            ]),
          )

          const model = yield* invitationByConstructId("model-only")
          expect(model[0]!._deleted).toBe(true)

          for (const id of ["dash-invite", "proc-invite", "legacy-invite"]) {
            const rows = yield* invitationByConstructId(id)
            expect(rows[0]!._deleted).toBe(false)
            expect(rows[0]!.invitationStatus).toBe(
              InvitationLifecycleStatus.Pending,
            )
            expect(rows[0]!.invitationSource).not.toBe(InvitationSource.Model)
            const invitationRoles = yield* activeInvitationRoles(rows[0]!.id)
            expect(invitationRoles.length).toBe(1)
          }

          const retained = yield* invitationByConstructId("retained-model")
          expect(retained[0]!._deleted).toBe(false)
        }),
    )

    it.effect(
      "remove/re-add reactivates only currently declared roles for a model invite",
      () =>
        Effect.gen(function* () {
          yield* storeOrganisation(
            makeOrgWithInvitations([
              {
                id: "cycle-invite",
                email: "cycle@example.com",
                roleIds: ["admin", "member"],
              },
            ]),
          )

          yield* storeOrganisation(makeOrgWithInvitations([]))

          const removed = yield* invitationByConstructId("cycle-invite")
          expect(removed[0]!._deleted).toBe(true)

          yield* storeOrganisation(
            makeOrgWithInvitations([
              {
                id: "cycle-invite",
                email: "cycle@example.com",
                roleIds: ["member"],
              },
            ]),
          )

          const readded = yield* invitationByConstructId("cycle-invite")
          const active = readded.filter((row) => !row._deleted)
          expect(active).toHaveLength(1)
          expect(active[0]!.invitationSource).toBe(InvitationSource.Model)
          expect(active[0]!.invitationStatus).toBe(
            InvitationLifecycleStatus.Pending,
          )
          expect(active[0]!.invitationPendingEmail).toBe("cycle@example.com")

          const roles = yield* activeInvitationRoles(active[0]!.id)
          expect(roles.map((r) => r.rolePath)).toEqual(["/member"])
        }),
    )
  },
)
