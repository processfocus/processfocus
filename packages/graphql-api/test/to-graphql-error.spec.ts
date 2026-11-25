import type { Context } from "effect"
import { Cause, DateTime, Effect, Layer, Logger, ManagedRuntime } from "effect"
import { SqlError, UnknownError } from "effect/sql/SqlError"
import { GraphQLError, graphql } from "graphql"
import { createSchema } from "graphql-yoga"
import {
  AuthorizationService,
  CurrentPrincipal,
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
  extractErrorFromCause,
  toGraphQLError,
} from "../src/lib/to-graphql-error"
import type { UserContext } from "../src/lib/types"
import { describe, expect, it } from "bun:test"

const fixedRequestTime = DateTime.makeUnsafe(
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
  canAccessField: Context.Service.Shape<
    typeof AuthorizationService
  >["canAccessField"],
): Context.Service.Shape<typeof AuthorizationService> => ({
  canIssueDelegationSecret: () => Effect.succeed(false),
  canListDelegationTokens: () => Effect.succeed(false),
  canManageDelegation: () => Effect.succeed(false),
  canLogin: () => Effect.succeed(false),
  policyVersion: Effect.succeed("test-policy"),
  canCompleteStep: () => Effect.succeed(false),
  canViewEmbeddedForm: () => Effect.succeed(false),
  canCorrectPublicCompletionTodo: () => Effect.succeed(false),
  canRequestRole: () => Effect.succeed(false),
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
  canAccessField: Context.Service.Shape<
    typeof AuthorizationService
  >["canAccessField"],
  logger: Logger.Logger<unknown, void> = Logger.defaultLogger,
) =>
  ManagedRuntime.make(
    Layer.mergeAll(
      Layer.succeed(
        AuthorizationService,
        denyAllAuthorizationService(canAccessField),
      ),
      Layer.succeed(RequestTime, fixedRequestTime),
      Layer.succeed(UserDetails, testUserDetails),
      Layer.succeed(CurrentPrincipal, null),
      Logger.layer([logger]),
    ),
  )

const captureLogs = () => {
  const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
  const logger = Logger.map(Logger.formatStructured, (entry) => {
    logs.push(entry)
  })
  return { logs, logger }
}

describe("toGraphQLError", () => {
  it("redacts SqlError to a generic database message", () => {
    const sqlError = new SqlError({
      reason: new UnknownError({
        message:
          "SQLITE_ERROR: no such table: secret_table SELECT api_key FROM secret_table",
        cause: { sql: "SELECT api_key FROM secret_table WHERE password = 'x'" },
      }),
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

describe("extractErrorFromCause", () => {
  it("unwraps the primary failure from a Cause", async () => {
    const sqlError = new SqlError({
      reason: new UnknownError({
        message: "SELECT * FROM leaked",
        cause: "db down",
      }),
    })

    const fiberFailure = Cause.fail(sqlError)

    const extracted = extractErrorFromCause(fiberFailure)
    expect(extracted).toBeInstanceOf(SqlError)
    expect((extracted as SqlError)._tag).toBe("SqlError")
  })

  it("unwraps a defect (Effect.die) from a Cause", async () => {
    const sqlError = new SqlError({
      reason: new UnknownError({
        message: "SELECT secret FROM defects",
        cause: "boom",
      }),
    })

    const fiberFailure = Cause.die(sqlError)

    const extracted = extractErrorFromCause(fiberFailure)
    expect(extracted).toBeInstanceOf(SqlError)
    expect(toGraphQLError(extracted).message).toBe("Database operation failed")
  })

  it("does not forward Cause pretty-printed messages", async () => {
    const fiberFailure = Cause.fail(
      new SqlError({
        reason: new UnknownError({
          message: "SELECT password FROM users",
          cause: "db",
        }),
      }),
    )

    // Defense in depth: if Cause is passed without extraction, redact.
    const result = toGraphQLError(fiberFailure)
    expect(result.message).toBe("Internal server error")
    expect(result.extensions).toEqual({ code: "INTERNAL_ERROR" })
    expect(JSON.stringify(result)).not.toContain("password")
    expect(JSON.stringify(result)).not.toContain("SELECT")
  })
})

describe("resolver failure diagnostics", () => {
  const runFailure = async (cause: unknown) => {
    const { logs, logger } = captureLogs()
    const runtime = makeAuthTestRuntime(() => Effect.succeed(true), logger)
    try {
      const executor = createResolverExecutor(runtime)
      await expect(
        executor.runWithFieldContext(
          Effect.fail(
            new SqlError({
              reason: new UnknownError({
                message: "Database read failed",
                cause,
              }),
            }),
          ),
          {
            spanName: "org",
            parentSpan: undefined,
            requestTime: fixedRequestTime,
            userDetails: testUserDetails,
            principal: null,
          },
        ),
      ).rejects.toMatchObject({
        message: "Database operation failed",
        extensions: { code: "DATABASE_ERROR" },
      })
      expect(logs).toHaveLength(1)
      return JSON.stringify(logs)
    } finally {
      await runtime.dispose()
    }
  }

  it.each([
    "connection failed https://db-user:db-password@db.example/query?authToken=url-token",
    'password="quoted password" token=bare-token api_key=private-key clientSecret=client-secret',
    "x-api-key=header-key x-security-token=header-token",
    "client failed: --password=flag-password --auth-token=flag-token",
    '{"access_token":"json-token", "refreshToken":"refresh-token", "username":"db-user"}',
    "Authorization: Bearer bearer-token; Basic basic-token",
    'connectionString="Data Source=private-host;Password=dsn-password"',
    "Failed query: SELECT * FROM users WHERE email = 'private-email'\nparams: private-parameter",
    "WITH private_values AS (VALUES ('private-email')) SELECT * FROM private_values",
    'query failed; parameters: ["private-parameter", "private-email"]',
  ])("redacts secrets in error messages and stacks: %s", async (message) => {
    const error = Object.assign(new Error(message), {
      code: "SQLITE_ERROR",
      // Only allowlisted error fields may be read or serialized.
      query: "private-query",
      params: ["private-parameter"],
      credentials: { password: "private-password" },
      toJSON: () => {
        throw new Error("must not serialize arbitrary errors")
      },
    })
    error.stack = `Error: ${message}\n    at execute (${message}:1:1)`
    const diagnostic = await runFailure(error)
    expect(diagnostic).toContain("SQLITE_ERROR")
    expect(diagnostic).toContain("[REDACTED")
    for (const secret of [
      "db-user",
      "db-password",
      "url-token",
      "quoted password",
      "bare-token",
      "private-key",
      "client-secret",
      "header-key",
      "header-token",
      "flag-password",
      "flag-token",
      "json-token",
      "refresh-token",
      "bearer-token",
      "basic-token",
      "private-host",
      "dsn-password",
      "private-email",
      "private-parameter",
      "private-query",
      "private-password",
    ]) {
      expect(diagnostic).not.toContain(secret)
    }
  })

  it("keeps later stack frames when an earlier frame matches a redaction rule", async () => {
    const error = new Error("connection reset")
    error.stack = [
      "Error: connection reset",
      "    at Object.update (/var/task/driver.js:10:2)",
      "    at execute (/var/task/query.js:20:3)",
      "    at request (https://db-user:stack-password@db.example?token=stack-token:25:4)",
      "    at resolver (/var/task/graphql.js:30:4)",
    ].join("\n")

    const diagnostic = await runFailure(error)
    expect(diagnostic).toContain("/var/task/query.js:20:3")
    expect(diagnostic).toContain("/var/task/graphql.js:30:4")
    expect(diagnostic).not.toContain("stack-password")
    expect(diagnostic).not.toContain("stack-token")
  })

  it("bounds cyclic, deep and oversized cause chains without crashing", async () => {
    const cycle = new Error("cyclic driver failure")
    cycle.cause = cycle
    const cyclicLog = await runFailure(cycle)
    expect(cyclicLog).toContain('"truncated":"cycle"')
    expect(cyclicLog).toContain("cyclic driver failure")

    let deep: unknown = new Error("unreachable tail")
    for (let i = 0; i < 100; i++) {
      deep = new Error("x".repeat(100_000), { cause: deep })
    }
    const deepLog = await runFailure(deep)
    expect(deepLog).toContain('"truncated":"depth"')
    expect(deepLog).not.toContain("unreachable tail")
    expect(deepLog.length).toBeLessThan(50_000)
    expect(cyclicLog.length).toBeLessThan(10_000)
  })

  it("handles reason-only wrappers and unreadable properties without serializing objects", async () => {
    const unreadable = Object.defineProperties(
      {},
      {
        message: {
          get: () => {
            throw new Error("unreadable message")
          },
        },
        stack: {
          get: () => {
            throw new Error("unreadable stack")
          },
        },
        cause: {
          get: () => {
            throw new Error("unreadable cause")
          },
        },
      },
    )
    const diagnostic = await runFailure({
      _tag: "SqlError",
      reason: {
        _tag: "UnknownError",
        cause: Object.assign(
          new Error("driver unavailable", { cause: unreadable }),
          {
            name: "DriverError",
            code: 14,
          },
        ),
      },
    })
    expect(diagnostic).toContain('"name":"DriverError"')
    expect(diagnostic).toContain('"message":"driver unavailable"')
    expect(diagnostic).toContain('"code":14')
    expect(diagnostic).not.toContain("unreadable message")
  })
})

describe("transformSchemaWithAuthDirective composition", () => {
  it.each([
    [
      "Mutation.startFake",
      'type Mutation { startFake: String @step(path: "/fake/Start") @processPermission }',
      "requires a generated process command resolver",
    ],
    [
      "Mutation.startFake",
      'type Mutation { startFake: String @auth(tag: "cron") @processPermission }',
      "cannot be combined with @auth",
    ],
    [
      "Query.lookup",
      'extend type Query { lookup: String @step(path: "/fake/Start") @processPermission }',
      "requires a generated process command resolver",
    ],
    [
      "Nested.value",
      "type Nested { value: String @processPermission }",
      "requires a generated process command resolver",
    ],
    [
      "Named.value",
      "interface Named { value: String @processPermission }",
      "requires a generated process command resolver",
    ],
  ])("rejects invalid @processPermission on %s", async (field, sdl, reason) => {
    const runtime = makeAuthTestRuntime(() => Effect.succeed(true))
    try {
      const schema = createSchema({
        typeDefs: `
          directive @step(path: String!) on FIELD_DEFINITION
          directive @auth(tag: String) on FIELD_DEFINITION
          directive @processPermission on FIELD_DEFINITION
          type Query { ready: Boolean }
          ${sdl}
        `,
      })
      expect(() =>
        transformSchemaWithAuthDirective(
          schema,
          createResolverExecutor(runtime),
        ),
      ).toThrow(`@processPermission on ${field} ${reason}`)
    } finally {
      await runtime.dispose()
    }
  })

  it("logs nested resolver causes while returning only the safe database error", async () => {
    const leakedSql =
      "SELECT password, api_key FROM users WHERE token = 'sk-secret-value'"
    const driver = Object.assign(
      new Error("socket hang up with connection reset"),
      {
        name: "TursoTransportError",
        code: "ECONNRESET",
      },
    )
    // Same shape as DrizzleQueryError, without a concrete DB dependency.
    const drizzleError = Object.assign(
      new Error(`Failed query: ${leakedSql}\nparams: sk-secret-value`, {
        cause: driver,
      }),
      {
        name: "DrizzleQueryError",
        query: leakedSql,
        params: ["sk-secret-value"],
      },
    )
    const sqlError = new SqlError({
      reason: new UnknownError({
        message: "Failed to execute Drizzle query",
        cause: drizzleError,
      }),
    })

    const baseSchema = createSchema({
      typeDefs: /* GraphQL */ `
        type Query {
          secret: String
        }
      `,
      resolvers: {
        Query: {
          secret: () =>
            Effect.logInfo("Reading protected field").pipe(
              Effect.andThen(Effect.fail(sqlError)),
            ),
        },
      },
    })

    const { logs, logger } = captureLogs()
    const runtime = makeAuthTestRuntime(() => Effect.succeed(true), logger)
    const parentSpan = Effect.runSync(
      Effect.currentSpan.pipe(Effect.withSpan("graphql.execute")),
    )

    try {
      const executor = createResolverExecutor(runtime)
      const schema = transformSchemaWithAuthDirective(baseSchema, executor)

      const result = await graphql({
        schema,
        source: "{ secret }",
        contextValue: {
          ...makeProviderUserContext(),
          _effectParentSpan: parentSpan,
        },
      })

      // The real GraphQL field boundary logs the failure and nulls the field.
      expect(result.data?.["secret"]).toBeNull()
      expect(result.errors).toHaveLength(1)

      const error = result.errors?.[0]
      expect(error).toBeDefined()
      expect(error?.message).toBe("Database operation failed")
      expect(error?.extensions?.["code"]).toBe("DATABASE_ERROR")

      const serialized = JSON.stringify(result)
      expect(serialized).not.toContain("usr-reviewer")
      expect(serialized).not.toContain("password")
      expect(serialized).not.toContain("api_key")
      expect(serialized).not.toContain("sk-secret-value")
      expect(serialized).not.toContain("SELECT")
      expect(serialized).not.toContain(leakedSql)
      expect(serialized).not.toContain("ECONNRESET")
      expect(serialized).not.toContain("TursoTransportError")
      expect(serialized).not.toContain("stack")

      const identity = {
        userId: "usr-reviewer",
        rolePath: "/Employee",
        orgUnitId: "ou-root",
        orgUnitPath: "/",
      }
      expect(logs).toHaveLength(2)
      expect(logs[0]).toMatchObject({
        message: "Reading protected field",
        annotations: identity,
      })
      expect(logs[1]?.annotations).toEqual(identity)
      expect(logs[1]?.message).toEqual([
        "GraphQL field failure",
        expect.objectContaining({
          field: "secret",
          traceId: parentSpan.traceId,
          spanId: expect.any(String),
          userId: identity.userId,
          error: {
            causes: [
              expect.objectContaining({ name: "SqlError" }),
              expect.objectContaining({ name: "UnknownError" }),
              expect.objectContaining({ name: "DrizzleQueryError" }),
              expect.objectContaining({
                name: "TursoTransportError",
                message: "socket hang up with connection reset",
                code: "ECONNRESET",
                stack: expect.stringContaining("at "),
              }),
            ],
            truncated: null,
          },
        }),
      ])
      expect(JSON.stringify(logs)).not.toContain("reviewer@example.com")
      expect(JSON.stringify(logs)).not.toContain("sk-secret-value")
      expect(JSON.stringify(logs)).not.toContain("SELECT")
      expect(JSON.stringify(logs)).not.toContain("[Error ...]")
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

  it("runs the Effect resolver with request s after allow", async () => {
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
