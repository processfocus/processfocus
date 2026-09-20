import { SqlError } from "@effect/sql/SqlError"
import { DateTime, Effect, FiberRef, Layer, ManagedRuntime } from "effect"
import { GraphQLError, graphql } from "graphql"
import { createSchema } from "graphql-yoga"
import {
  AuthorizationService,
  CurrentPrincipal,
  type ProviderUserPrincipal,
  getCurrentPrincipal,
} from "@pf/auth-policy"
import {
  UserDetails,
  type UserDetailsValue,
  getUserDetails,
} from "@pf/graphql-db-operations"
import { InputValidationError, NotAuthorized } from "@pf/graphql-schema"
import { RequestTime, getRequestTime } from "@pf/request-time"
import { transformSchemaWithAuthDirective } from "../src/lib/auth-directive-plugin"
import { createResolverExecutor } from "../src/lib/resolver-utils"
import {
  extractErrorFromFiberFailure,
  toGraphQLError,
} from "../src/lib/to-graphql-error"
import type { UserContext } from "../src/lib/types"
import { describe, expect, it } from "bun:test"

const fixedRequestTime = DateTime.unsafeMake(
  new Date("2026-03-27T00:00:00.000Z"),
)

const testUserDetails: UserDetailsValue = { by: "test", id: "usr-test" }

const makeServiceAccountContext = (): UserContext => ({
  _requestTime: fixedRequestTime,
  _userDetails: testUserDetails,
  jwt: {
    mode: "access",
    type: "user",
    properties: {
      userId: "svc-test",
      clientId: "svc-test",
      roles: ["admin"],
    },
    aud: "graphql-api",
    iss: "http://localhost:4020",
    sub: "svc-test",
    exp: 0,
    iat: 0,
  },
  userId: "svc-test",
})

const makeProviderUserContext = (): UserContext => ({
  _requestTime: fixedRequestTime,
  _userDetails: { by: "reviewer@example.com", id: "usr-reviewer" },
  jwt: {
    mode: "access",
    type: "providerUser",
    properties: {
      userId: "usr-reviewer",
      email: "reviewer@example.com",
      roles: ["/Employee"],
      orgUnitPath: "/",
      orgUnitId: "ou-root",
    },
    aud: "graphql-api",
    iss: "http://localhost:4020",
    sub: "providerUser:reviewer",
    exp: 0,
    iat: 0,
  },
  userId: "usr-reviewer",
})

const denyAllAuthorizationService = (
  canAccessField: AuthorizationService["Type"]["canAccessField"],
): AuthorizationService["Type"] => ({
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
  canAccessField,
  canAccessFeature: () => Effect.succeed(false),
  canAccessList: () => Effect.succeed(false),
  canCreateList: () => Effect.succeed(false),
  canUpdateList: () => Effect.succeed(false),
  canDeleteList: () => Effect.succeed(false),
  canDownloadFile: () => Effect.succeed(false),
  canDeleteFile: () => Effect.succeed(false),
  canPerformAction: () => Effect.succeed(false),
})

const makeAuthTestRuntime = (
  canAccessField: AuthorizationService["Type"]["canAccessField"],
) =>
  ManagedRuntime.make(
    Layer.mergeAll(
      Layer.succeed(
        AuthorizationService,
        denyAllAuthorizationService(canAccessField),
      ),
      Layer.succeed(RequestTime, FiberRef.unsafeMake(fixedRequestTime)),
      Layer.succeed(UserDetails, FiberRef.unsafeMake(testUserDetails)),
      Layer.succeed(
        CurrentPrincipal,
        FiberRef.unsafeMake<ProviderUserPrincipal | null>(null),
      ),
    ),
  )

describe("toGraphQLError", () => {
  it("redacts SqlError to a generic database message", () => {
    const sqlError = new SqlError({
      message:
        "SQLITE_ERROR: no such table: secret_table SELECT api_key FROM secret_table",
      cause: { sql: "SELECT api_key FROM secret_table WHERE password = 'x'" },
    })

    const result = toGraphQLError(sqlError)

    expect(result).toBeInstanceOf(GraphQLError)
    expect(result.message).toBe("Database operation failed")
    expect(result.extensions).toEqual({ code: "DATABASE_ERROR" })
    expect(JSON.stringify(result)).not.toContain("secret_table")
    expect(JSON.stringify(result)).not.toContain("api_key")
    expect(JSON.stringify(result)).not.toContain("password")
  })

  it("preserves InputValidationError field errors in extensions", () => {
    const validationError = new InputValidationError({
      errors: [{ field: "email", message: "is required" }],
    })

    const result = toGraphQLError(validationError)

    expect(result.message).toContain("email")
    expect(result.extensions?.["code"]).toBe("InputValidationError")
    expect(result.extensions?.["errors"]).toEqual([
      { field: "email", message: "is required" },
    ])
  })

  it("maps NotAuthorized tagged errors with extensions", () => {
    const notAuthorized = new NotAuthorized({
      action: "query",
      resource: "Query.secret",
      message: "Not authorized: denied",
    })

    const result = toGraphQLError(notAuthorized)

    expect(result.message).toBe("Not authorized: denied")
    expect(result.extensions?.["code"]).toBe("NotAuthorized")
    expect(result.extensions?.["action"]).toBe("query")
    expect(result.extensions?.["resource"]).toBe("Query.secret")
  })
})

describe("extractErrorFromFiberFailure", () => {
  it("unwraps the primary failure from a FiberFailure", async () => {
    const sqlError = new SqlError({
      message: "SELECT * FROM leaked",
      cause: "db down",
    })

    let fiberFailure: unknown
    try {
      await Effect.runPromise(Effect.fail(sqlError))
    } catch (error) {
      fiberFailure = error
    }

    const extracted = extractErrorFromFiberFailure(fiberFailure)
    expect(extracted).toBeInstanceOf(SqlError)
    expect((extracted as SqlError)._tag).toBe("SqlError")
  })

  it("unwraps a defect (Effect.die) from a FiberFailure", async () => {
    const sqlError = new SqlError({
      message: "SELECT secret FROM defects",
      cause: "boom",
    })

    let fiberFailure: unknown
    try {
      await Effect.runPromise(Effect.die(sqlError))
    } catch (error) {
      fiberFailure = error
    }

    const extracted = extractErrorFromFiberFailure(fiberFailure)
    expect(extracted).toBeInstanceOf(SqlError)
    expect(toGraphQLError(extracted).message).toBe("Database operation failed")
  })

  it("does not forward FiberFailure pretty-printed messages", async () => {
    let fiberFailure: unknown
    try {
      await Effect.runPromise(
        Effect.fail(
          new SqlError({
            message: "SELECT password FROM users",
            cause: "db",
          }),
        ),
      )
    } catch (error) {
      fiberFailure = error
    }

    // Defense in depth: if FiberFailure is passed without extraction, redact.
    const result = toGraphQLError(fiberFailure)
    expect(result.message).toBe("Internal server error")
    expect(result.extensions).toEqual({ code: "INTERNAL_ERROR" })
    expect(JSON.stringify(result)).not.toContain("password")
    expect(JSON.stringify(result)).not.toContain("SELECT")
  })
})

describe("transformSchemaWithAuthDirective composition", () => {
  it("returns only the redacted database message when @auth raises SqlError", async () => {
    const leakedSql =
      "SELECT password, api_key FROM users WHERE token = 'sk-secret-value'"
    const sqlError = new SqlError({
      message: leakedSql,
      cause: { sql: leakedSql, params: ["sk-secret-value"] },
    })

    const baseSchema = createSchema({
      typeDefs: /* GraphQL */ `
        type Query {
          secret: String
        }
      `,
      resolvers: {
        Query: {
          secret: () => "should-not-run",
        },
      },
    })

    const runtime = makeAuthTestRuntime(
      () =>
        Effect.fail(sqlError) as unknown as Effect.Effect<
          boolean,
          never,
          RequestTime
        >,
    )

    try {
      const executor = createResolverExecutor(runtime)
      const schema = transformSchemaWithAuthDirective(baseSchema, executor)

      const result = await graphql({
        schema,
        source: "{ secret }",
        contextValue: makeServiceAccountContext(),
      })

      // GraphQL nulls the field when the resolver throws; original resolver must not run.
      expect(result.data?.["secret"]).toBeNull()
      expect(result.errors).toHaveLength(1)

      const error = result.errors?.[0]
      expect(error).toBeDefined()
      expect(error?.message).toBe("Database operation failed")
      expect(error?.extensions?.["code"]).toBe("DATABASE_ERROR")

      const serialized = JSON.stringify(result)
      expect(serialized).not.toContain("password")
      expect(serialized).not.toContain("api_key")
      expect(serialized).not.toContain("sk-secret-value")
      expect(serialized).not.toContain("SELECT")
      expect(serialized).not.toContain(leakedSql)
    } finally {
      await runtime.dispose()
    }
  })

  it("does not invoke the original resolver when Cedar denies", async () => {
    let resolverInvoked = false
    const baseSchema = createSchema({
      typeDefs: /* GraphQL */ `
        type Query {
          secret: String
        }
      `,
      resolvers: {
        Query: {
          secret: () => {
            resolverInvoked = true
            return Effect.succeed("leaked")
          },
        },
      },
    })

    const runtime = makeAuthTestRuntime(() => Effect.succeed(false))

    try {
      const executor = createResolverExecutor(runtime)
      const schema = transformSchemaWithAuthDirective(baseSchema, executor)

      const result = await graphql({
        schema,
        source: "{ secret }",
        contextValue: makeServiceAccountContext(),
      })

      expect(resolverInvoked).toBe(false)
      expect(result.data?.["secret"]).toBeNull()
      expect(result.errors).toHaveLength(1)
      expect(result.errors?.[0]?.extensions?.["code"]).toBe("NotAuthorized")
    } finally {
      await runtime.dispose()
    }
  })

  it("runs the Effect resolver with request FiberRefs after allow", async () => {
    let sawRequestTime: DateTime.Utc | undefined
    let sawUserDetails: UserDetailsValue | undefined
    let sawPrincipalEmail: string | null | undefined

    const baseSchema = createSchema({
      typeDefs: /* GraphQL */ `
        type Query {
          secret: String
        }
      `,
      resolvers: {
        Query: {
          secret: () =>
            Effect.gen(function* () {
              sawRequestTime = yield* getRequestTime()
              sawUserDetails = yield* getUserDetails()
              const principal = yield* getCurrentPrincipal()
              sawPrincipalEmail = principal?.uid.id ?? null
              return "ok"
            }),
        },
      },
    })

    const runtime = makeAuthTestRuntime(() => Effect.succeed(true))

    try {
      const executor = createResolverExecutor(runtime)
      const schema = transformSchemaWithAuthDirective(baseSchema, executor)
      const context = makeProviderUserContext()

      const result = await graphql({
        schema,
        source: "{ secret }",
        contextValue: context,
      })

      expect(result.errors).toBeUndefined()
      expect(result.data?.["secret"]).toBe("ok")
      expect(sawRequestTime).toEqual(fixedRequestTime)
      expect(sawUserDetails).toEqual(context._userDetails)
      // buildCurrentPrincipal uses email as the principal id for provider users
      expect(sawPrincipalEmail).toBe("reviewer@example.com")
    } finally {
      await runtime.dispose()
    }
  })
})
