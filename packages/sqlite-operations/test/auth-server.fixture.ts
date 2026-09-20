import { FetchHttpClient } from "@effect/platform"
import { Effect, Layer } from "effect"
import { OpenAuthMemoryStorageServiceLive } from "@pf/auth-api"
import * as schema from "@pf/drizzle-sqlite"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite"
import { DatabaseTest } from "@pf/service-drizzle-sqlite/test"
import { SqliteAuthenticationDatabaseLive } from "../src/lib/authentication-database.js"

export const TestLayer = Layer.provideMerge(
  Layer.mergeAll(
    SqliteAuthenticationDatabaseLive,
    OpenAuthMemoryStorageServiceLive,
    FetchHttpClient.layer,
  ),
  DatabaseTest,
)

export const setupTestData = (testEmail: string) =>
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
      .returning()

    if (!rootOrgUnit) {
      throw new Error("Failed to create org unit")
    }

    const [testerRole] = yield* db
      .insert(schema.role)
      .values({
        name: "Tester",
        orgUnitId: rootOrgUnit.id,
        path: `${rootOrgUnit.path}Tester`,
      })
      .returning()

    if (!testerRole) {
      throw new Error("Failed to create role")
    }

    const [invitation] = yield* db
      .insert(schema.invitation)
      .values({
        invitationId: "test-invitation-1",
        email: testEmail.toLowerCase(),
        invitationStatus: "pending",
        invitationSource: "dashboard",
        invitationPendingEmail: testEmail.toLowerCase(),
      })
      .returning()

    if (!invitation) {
      throw new Error("Failed to create invitation")
    }

    yield* db.insert(schema.invitationRole).values({
      invitationId: invitation.id,
      roleId: testerRole.id,
    })

    return {
      rootOrgUnitId: rootOrgUnit.id,
      rootOrgUnitPath: rootOrgUnit.path,
      testerRoleId: testerRole.id,
      testerRolePath: testerRole.path,
      invitationId: invitation.id,
    }
  })
