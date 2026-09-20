import { FileSystem } from "@effect/platform"
import { DateTime, Effect, Layer, Option } from "effect"
import { AuthorizationService } from "@pf/auth-policy"
import {
  OAuthClientQueries,
  OrgQueries,
  ProcessQueries,
  ProviderUserQueries,
  type ProviderUserRow,
  WorkflowQueries,
} from "@pf/graphql-db-operations"
import { systemSchema } from "../src/lib/system-resolvers"
import type { UserContext } from "../src/lib/types"
import { describe, expect, it } from "bun:test"

const providerUser: ProviderUserRow = {
  id: "provider-user-1",
  userId: "user-1",
  email: "admin@example.com",
  name: "Admin User",
  firstName: "Admin",
  lastName: "User",
  picture: "",
  locale: "en",
  provider: "dummy",
  sub: "dummy-admin",
  orgUnitId: "root-org-unit",
  orgUnitPath: "/",
  createdAt: new Date("2026-04-06T10:00:00.000Z"),
  updatedAt: new Date("2026-04-06T10:00:00.000Z"),
  createdBy: null,
  updatedBy: null,
}

const makeContext = (): UserContext => ({
  _requestTime: DateTime.unsafeMake("2026-04-06T10:00:00.000Z"),
  _userDetails: {
    by: "admin@example.com",
    id: "user-1",
  } as UserContext["_userDetails"],
  jwt: {
    mode: "access",
    type: "user",
    properties: {
      userId: "user-1",
      email: "admin@example.com",
      roles: ["/Limited"],
      orgUnitPath: "/",
      orgUnitId: "root-org-unit",
    },
    aud: "graphql-api",
    iss: "http://localhost:4020",
    sub: "user-1",
    exp: 0,
    iat: 0,
  },
  userId: "user-1",
})

const makeAuthorizationService = (
  seenRoleSets: string[][],
): AuthorizationService["Type"] => ({
  canIssueDelegationSecret: () => Effect.succeed(false),
  canListDelegationTokens: () => Effect.succeed(false),
  canManageDelegation: () => Effect.succeed(false),
  canLogin: () => Effect.succeed(false),
  canCompleteStep: () => Effect.succeed(false),
  canCompleteTodo: () => Effect.succeed(false),
  canCorrectPublicCompletionTodo: () => Effect.succeed(false),
  canCompletePublicTodo: () => Effect.succeed(false),
  canRequestRole: (principal, resource) => {
    seenRoleSets.push(principal.roles.map((role) => role.id))
    return Effect.succeed(
      principal.roles.some((role) => role.id === "/Admin") &&
        ["/Admin", "/Limited"].includes(resource.uid.id),
    )
  },
  canRequestProviderUserPermissions: () => Effect.succeed(false),
  canActOnBehalfOf: () => Effect.succeed(false),
  canViewExecution: () => Effect.succeed(false),
  canRestartExecution: () => Effect.succeed(false),
  canAbandonStep: () => Effect.succeed(false),
  canDraftStep: () => Effect.succeed(false),
  canModifyField: () => Effect.succeed(false),
  canAccessField: () => Effect.succeed(false),
  canAccessFeature: () => Effect.succeed(false),
  canAccessList: () => Effect.succeed(false),
  canCreateList: () => Effect.succeed(false),
  canUpdateList: () => Effect.succeed(false),
  canDeleteList: () => Effect.succeed(false),
  canDownloadFile: () => Effect.succeed(false),
  canDeleteFile: () => Effect.succeed(false),
  canPerformAction: () => Effect.succeed(false),
})

const makeProviderUserQueries = (permittedRoleIds: string[]) => ({
  queryProviderUserByUserId: (userId: string) =>
    Effect.succeed(
      userId === "user-1" ? Option.some(providerUser) : Option.none(),
    ),
  queryProviderUserByProviderUserId: (providerUserId: string) =>
    Effect.succeed(
      providerUserId === providerUser.id
        ? Option.some(providerUser)
        : Option.none(),
    ),
  queryProviderUserRolePaths: (providerUserId: string) =>
    Effect.succeed(providerUserId === providerUser.id ? ["/Admin"] : []),
  queryAllRoles: () =>
    Effect.succeed([
      { id: "role-admin", name: "Admin", path: "/Admin" },
      { id: "role-limited", name: "Limited", path: "/Limited" },
      { id: "role-other", name: "Other", path: "/Other" },
    ]),
  queryRoleByPath: (path: string) =>
    Effect.succeed(
      path === "/Admin"
        ? Option.some({ id: "role-admin", name: "Admin", path: "/Admin" })
        : Option.none(),
    ),
  addPermittedRole: (providerUserId: string, roleId: string) =>
    Effect.sync(() => {
      if (providerUserId === providerUser.id) permittedRoleIds.push(roleId)
    }),
})

const makeLayer = (seenRoleSets: string[][], permittedRoleIds: string[] = []) =>
  Layer.mergeAll(
    Layer.succeed(FileSystem.FileSystem, {
      readFileString: () => Effect.succeed("type Query { _: Boolean }"),
    } as unknown as FileSystem.FileSystem),
    Layer.succeed(OrgQueries, {} as unknown as OrgQueries["Type"]),
    Layer.succeed(ProcessQueries, {
      queryAllProcesses: Effect.succeed([]),
    } as unknown as ProcessQueries["Type"]),
    Layer.succeed(
      ProviderUserQueries,
      makeProviderUserQueries(
        permittedRoleIds,
      ) as unknown as ProviderUserQueries["Type"],
    ),
    Layer.succeed(WorkflowQueries, {} as unknown as WorkflowQueries["Type"]),
    Layer.succeed(
      OAuthClientQueries,
      {} as unknown as OAuthClientQueries["Type"],
    ),
    Layer.succeed(AuthorizationService, makeAuthorizationService(seenRoleSets)),
  )

type RoleSwitchRole = {
  readonly id: string
  readonly name: string
  readonly path: string
}

type RequestRoleResult = {
  readonly success: boolean
  readonly rolePath: string | null
  readonly error: string | null
}

describe("system role switching resolvers", () => {
  it("lists switchable roles from account roles after the active session is narrowed", async () => {
    const seenRoleSets: string[][] = []

    const roles = await Effect.runPromise(
      Effect.gen(function* () {
        const schema = yield* systemSchema
        const resolver = schema.resolvers?.ProviderUser?.["permittedRoles"] as
          | ((
              parent: ProviderUserRow,
              args: unknown,
              context: UserContext,
            ) => Effect.Effect<readonly RoleSwitchRole[], unknown, never>)
          | undefined

        if (!resolver) return yield* Effect.dieMessage("Missing resolver")

        return yield* resolver(providerUser, {}, makeContext())
      }).pipe(Effect.provide(makeLayer(seenRoleSets))),
    )

    expect(roles.map((role) => role.path)).toEqual(["/Admin", "/Limited"])
    expect(seenRoleSets).toEqual([["/Admin"], ["/Admin"], ["/Admin"]])
  })

  it("requests a previous account role after the active session is narrowed", async () => {
    const seenRoleSets: string[][] = []
    const permittedRoleIds: string[] = []

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const schema = yield* systemSchema
        const resolver = schema.resolvers?.Mutation?.["requestRole"] as
          | ((
              parent: unknown,
              args: { rolePath: string },
              context: UserContext,
            ) => Effect.Effect<RequestRoleResult, unknown, never>)
          | undefined

        if (!resolver) return yield* Effect.dieMessage("Missing resolver")

        return yield* resolver(undefined, { rolePath: "/Admin" }, makeContext())
      }).pipe(Effect.provide(makeLayer(seenRoleSets, permittedRoleIds))),
    )

    expect(result).toEqual({
      success: true,
      rolePath: "/Admin",
      error: null,
    })
    expect(seenRoleSets).toEqual([["/Admin"]])
    expect(permittedRoleIds).toEqual(["role-admin"])
  })
})
