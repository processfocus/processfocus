import { FileSystem } from "@effect/platform"
import { DateTime, Effect, Either, Layer, Schema } from "effect"
import { AuthorizationService } from "@pf/auth-policy"
import { ProcessQueries } from "@pf/graphql-db-operations"
import { InputValidationError } from "@pf/graphql-schema"
import {
  List,
  type ListQueryContext,
  ListSortable,
  ListVisibleInList,
  Organisation,
  OrganisationProvider,
  Role,
} from "@pf/process"
import { dynamicSchema } from "../src/lib/dynamic-resolvers"
import { DynamicSchemaConfig } from "../src/lib/graphql-api"
import type { UserContext } from "../src/lib/types"
import { describe, expect, it } from "bun:test"

const makeContext = (): UserContext => ({
  _requestTime: DateTime.unsafeMake("2026-04-06T10:00:00.000Z"),
  _userDetails: {
    by: "current@example.com",
    id: "current@example.com",
  } as UserContext["_userDetails"],
  jwt: {
    mode: "access",
    type: "user",
    properties: {
      userId: "current@example.com",
      email: "current@example.com",
      roles: ["/viewer"],
      orgUnitPath: "/",
      orgUnitId: "/",
    },
    aud: "graphql-api",
    iss: "http://localhost:4020",
    sub: "current@example.com",
    exp: 0,
    iat: 0,
  },
  userId: "current@example.com",
})

const makeAuthorizationService = (): AuthorizationService["Type"] => ({
  canIssueDelegationSecret: () => Effect.succeed(false),
  canListDelegationTokens: () => Effect.succeed(false),
  canManageDelegation: () => Effect.succeed(false),
  canLogin: () => Effect.succeed(false),
  canCompleteStep: () => Effect.succeed(false),
  canCompleteTodo: () => Effect.succeed(false),
  canCorrectPublicCompletionTodo: () => Effect.succeed(false),
  canCompletePublicTodo: () => Effect.succeed(false),
  canRequestRole: () => Effect.succeed(false),
  canRequestProviderUserPermissions: () => Effect.succeed(false),
  canActOnBehalfOf: () => Effect.succeed(false),
  canViewExecution: () => Effect.succeed(false),
  canRestartExecution: () => Effect.succeed(false),
  canAbandonStep: () => Effect.succeed(false),
  canDraftStep: () => Effect.succeed(false),
  canModifyField: () => Effect.succeed(false),
  canAccessField: () => Effect.succeed(false),
  canAccessFeature: () => Effect.succeed(false),
  canAccessList: () => Effect.succeed(true),
  canCreateList: () => Effect.succeed(false),
  canUpdateList: () => Effect.succeed(false),
  canDeleteList: () => Effect.succeed(false),
  canDownloadFile: () => Effect.succeed(false),
  canDeleteFile: () => Effect.succeed(false),
  canPerformAction: () => Effect.succeed(false),
})

const makeLayer = (org: Organisation) =>
  Layer.mergeAll(
    Layer.succeed(FileSystem.FileSystem, {
      exists: () => Effect.succeed(true),
      readFileString: () => Effect.succeed("type Query { _: Boolean }"),
    } as unknown as FileSystem.FileSystem),
    Layer.succeed(DynamicSchemaConfig, { schemaPath: "/tmp/org.graphql" }),
    Layer.succeed(ProcessQueries, {
      queryAllProcesses: Effect.succeed([]),
    } as unknown as ProcessQueries["Type"]),
    Layer.succeed(AuthorizationService, makeAuthorizationService()),
    Layer.succeed(OrganisationProvider, {
      organisation: org,
      orgPath: "/tmp/org",
      schemaPath: "/tmp/org.graphql",
    }),
  )

interface ListResolverArgs {
  readonly page: number
  readonly limit: number
  readonly filter?: string
  readonly sort?: { readonly field: string; readonly direction: "ASC" | "DESC" }
}

const resolveEmployees = (org: Organisation, args: ListResolverArgs) =>
  Effect.gen(function* () {
    const schema = yield* dynamicSchema
    const resolver = (schema.resolvers?.Query?.["listEmployees"] ??
      (() =>
        Effect.dieMessage("Missing listEmployees resolver"))) as unknown as (
      parent: unknown,
      args: ListResolverArgs,
      context: UserContext,
    ) => Effect.Effect<unknown, unknown, never>

    return yield* resolver(undefined, args, makeContext())
  }).pipe(Effect.provide(makeLayer(org)))

describe("dynamic list sort resolver", () => {
  it("preserves existing query context when sort input is omitted", async () => {
    const org = new Organisation({ name: "test-org" })
    const role = new Role(org, "viewer")
    let receivedContext: ListQueryContext | undefined

    new List(org, "employees", {
      name: "Employees",
      roles: [role],
      output: {
        id: Schema.String,
        name: Schema.String,
      },
      query: (ctx) => {
        receivedContext = ctx
        return Effect.succeed({ items: [], totalCount: 0 })
      },
    })

    await Effect.runPromise(
      resolveEmployees(org, {
        page: 2,
        limit: 10,
        filter: "Jane",
      }),
    )

    expect(receivedContext).toEqual({
      page: 2,
      limit: 10,
      filter: "Jane",
    })
  })

  it("passes validated sort input to the list query context", async () => {
    const org = new Organisation({ name: "test-org" })
    const role = new Role(org, "viewer")
    let receivedContext: ListQueryContext | undefined

    new List(org, "employees", {
      name: "Employees",
      roles: [role],
      output: {
        id: Schema.String,
        name: Schema.String,
      },
      query: (ctx) => {
        receivedContext = ctx
        return Effect.succeed({ items: [], totalCount: 0 })
      },
    })

    await Effect.runPromise(
      resolveEmployees(org, {
        page: 1,
        limit: 20,
        sort: { field: "name", direction: "DESC" },
      }),
    )

    expect(receivedContext?.sort).toEqual({ field: "name", direction: "DESC" })
  })

  it("accepts explicitly sortable hidden output fields", async () => {
    const org = new Organisation({ name: "test-org" })
    const role = new Role(org, "viewer")
    let receivedContext: ListQueryContext | undefined

    new List(org, "employees", {
      name: "Employees",
      roles: [role],
      output: {
        id: Schema.String,
        internalOrder: Schema.String.annotations({
          [ListVisibleInList]: false,
          [ListSortable]: true,
        }),
      },
      query: (ctx) => {
        receivedContext = ctx
        return Effect.succeed({ items: [], totalCount: 0 })
      },
    })

    await Effect.runPromise(
      resolveEmployees(org, {
        page: 1,
        limit: 20,
        sort: { field: "internalOrder", direction: "ASC" },
      }),
    )

    expect(receivedContext?.sort).toEqual({
      field: "internalOrder",
      direction: "ASC",
    })
  })

  it("rejects unsupported sort fields before executing the list query", async () => {
    const org = new Organisation({ name: "test-org" })
    const role = new Role(org, "viewer")
    let queryExecuted = false

    new List(org, "employees", {
      name: "Employees",
      roles: [role],
      output: {
        id: Schema.String,
        hiddenCode: Schema.String.annotations({
          [ListVisibleInList]: false,
        }),
      },
      query: () => {
        queryExecuted = true
        return Effect.succeed({ items: [], totalCount: 0 })
      },
    })

    const result = await Effect.runPromise(
      Effect.either(
        resolveEmployees(org, {
          page: 1,
          limit: 20,
          sort: { field: "hiddenCode", direction: "ASC" },
        }),
      ),
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      const error = result.left
      expect(error).toBeInstanceOf(InputValidationError)
      if (error instanceof InputValidationError) {
        expect(error.message).toContain("sort.field")
      }
    }
    expect(queryExecuted).toBe(false)
  })
})
