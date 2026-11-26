import { Context, Effect, Layer, Logger, ManagedRuntime } from "effect"
import { createSchema } from "graphql-yoga"
import { SignJWT, exportJWK, generateKeyPair } from "jose"
import { InvalidRolePreparation } from "@pf/auth-api"
import {
  LocalCedarAuthorizationLive,
  LocalCedarConfig,
  getDefaultSchemaPath,
} from "@pf/auth-local-cedar"
import {
  ExecutionIdConflictError,
  InputValidationError,
} from "@pf/graphql-schema"
import { AuthConfig, GRAPHQL_AUDIENCE } from "../src/lib/auth-config"
import {
  AppSchemaBuilder,
  ResolverRuntime,
  type UserContext,
  Yoga,
  YogaLive,
} from "../src/lib/graphql-api"
import { expect, spyOn, test } from "bun:test"

test("Lambda GraphQL logs request and field failures at the right level with verified identity", async () => {
  const { publicKey, privateKey } = await generateKeyPair("ES256")
  const jwk = await exportJWK(publicKey)
  const jwks = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ keys: [{ ...jwk, alg: "ES256" }] }),
  })
  const previousFunctionName = process.env["AWS_LAMBDA_FUNCTION_NAME"]
  const stubServices = Context.makeUnsafe<unknown>(new Map())
  const projectMissing = 'Project "unrelated-project" was not found.'
  const stageMissing = "Stage not found in project: unrelated-stage"
  const environmentMissing = "Environment not found."
  const projectFailure = "Failed to generate the registration link."
  const projectConfigError = (message: string) =>
    Effect.fail({ _tag: "ProjectConfigAccessError", message })
  const cedar = LocalCedarAuthorizationLive.pipe(
    Layer.provide(
      Layer.effect(
        LocalCedarConfig,
        Effect.promise(async () => ({
          schemaText: await Bun.file(getDefaultSchemaPath()).text(),
          policiesText: [
            'permit(principal, action == PF::Action::"query", resource is PF::GraphQLField) unless { resource == PF::GraphQLField::"Query.denied" };',
          ],
        })),
      ),
    ),
  )
  const resolverLogs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Layer.succeedContext(stubServices),
      cedar,
      Logger.layer([
        Logger.map(Logger.formatStructured, (entry) => {
          resolverLogs.push(entry)
        }),
      ]),
    ),
  )
  const writes: string[] = []
  const stdout = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    writes.push(chunk.toString())
    return true
  })

  try {
    process.env["AWS_LAMBDA_FUNCTION_NAME"] = "graphql-test"
    const issuerUrl = jwks.url.origin
    const identity = {
      userId: "usr-yoga-logging",
      rolePath: "/Automation",
      orgUnitId: "ou-yoga-logging",
      orgUnitPath: "/Operations",
    }
    const token = await new SignJWT({
      type: "serviceAccount",
      properties: {
        clientId: "yoga-logging-test",
        userId: identity.userId,
        roles: [identity.rolePath],
        orgUnitId: identity.orgUnitId,
        orgUnitPath: identity.orgUnitPath,
      },
    })
      .setProtectedHeader({ alg: "ES256" })
      .setIssuer(issuerUrl)
      .setAudience(GRAPHQL_AUDIENCE)
      .setExpirationTime("5m")
      .sign(privateKey)
    const yoga = await Effect.runPromiseWith(stubServices)(
      Yoga.pipe(
        Effect.provide(YogaLive),
        Effect.provideService(AppSchemaBuilder, {
          toSchema: Effect.succeed(
            createSchema<UserContext>({
              typeDefs: `
                type Query {
                  denied: String
                  missingProject: String
                  missingStage: String
                  missingEnvironment: String
                  projectFailure: String
                  invalidInput: String
                  executionIdConflict: String
                  invalidRolePreparation: String
                  broken: String
                }
              `,
              resolvers: {
                Query: {
                  missingProject: () => projectConfigError(projectMissing),
                  missingStage: () => projectConfigError(stageMissing),
                  missingEnvironment: () =>
                    projectConfigError(environmentMissing),
                  projectFailure: () => projectConfigError(projectFailure),
                  invalidInput: () =>
                    new InputValidationError({
                      errors: [{ field: "name", message: "Name is required" }],
                    }),
                  executionIdConflict: () =>
                    new ExecutionIdConflictError({
                      executionId: "exec-reused",
                    }),
                  invalidRolePreparation: () =>
                    new InvalidRolePreparation({ reason: "missing-session" }),
                  broken: () => {
                    throw new Error("Resolver defect")
                  },
                },
              },
            }),
          ),
        }),
        Effect.provideService(AuthConfig, {
          issuerUrl,
          issuerUrls: [issuerUrl],
          jwksUri: `${issuerUrl}/.well-known/jwks.json`,
        }),
        Effect.provideService(ResolverRuntime, runtime),
      ),
    )
    for (const { query, authenticated, error, alarm } of [
      { error: { extensions: { code: "BAD_REQUEST" } } },
      {
        query: "{ denied }",
        authenticated: true,
        error: {
          extensions: { code: "NotAuthorized", resource: "Query.denied" },
        },
      },
      {
        query: "{ invalidInput }",
        authenticated: true,
        error: { extensions: { code: "InputValidationError" } },
      },
      {
        query: "{ executionIdConflict }",
        authenticated: true,
        error: { extensions: { code: "ExecutionIdConflictError" } },
      },
      {
        query: "{ invalidRolePreparation }",
        authenticated: true,
        error: {
          extensions: {
            code: "InvalidRolePreparation",
            reason: "missing-session",
          },
        },
      },
      {
        query: "{ missingProject }",
        authenticated: true,
        error: {
          message: projectMissing,
          extensions: { code: "ProjectConfigAccessError" },
        },
      },
      {
        query: "{ missingStage }",
        authenticated: true,
        error: {
          message: stageMissing,
          extensions: { code: "ProjectConfigAccessError" },
        },
      },
      {
        query: "{ missingEnvironment }",
        authenticated: true,
        error: {
          message: environmentMissing,
          extensions: { code: "ProjectConfigAccessError" },
        },
      },
      {
        query: "{ projectFailure }",
        authenticated: true,
        error: {
          message: projectFailure,
          extensions: { code: "ProjectConfigAccessError" },
        },
        alarm: true,
      },
      {
        query: "{ broken }",
        authenticated: true,
        error: { message: "Resolver defect", path: ["broken"] },
        alarm: true,
      },
      {
        query: "{ denied }",
        error: { extensions: { code: "UNAUTHENTICATED" } },
      },
    ]) {
      writes.length = 0
      resolverLogs.length = 0
      const response = await yoga.fetch("http://localhost/graphql", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/graphql-response+json",
          ...(authenticated ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ query }),
      })
      const body = await response.json()
      expect(body).toMatchObject({ errors: [error] })
      expect(JSON.stringify(body)).not.toContain(identity.userId)
      expect(writes.join("")).not.toContain(token)

      const lines = writes.filter((line) => line.startsWith("{"))
      for (const line of lines) expect(line).toMatch(/^\{[^\r\n]*\}\n$/)
      const entries = lines.map((line) => JSON.parse(line))
      const summaries = entries.filter(
        (entry) => entry.message === "Request processed",
      )
      const annotations = authenticated ? identity : {}
      expect(summaries).toEqual([
        expect.objectContaining({
          level: "INFO",
          errorCount: 1,
          status: response.status,
          durationMs: expect.any(Number),
          annotations,
        }),
      ])
      const errorLogs = entries.filter((entry) => entry.err !== undefined)
      expect(errorLogs).toHaveLength(1)
      expect(errorLogs[0]).toMatchObject({
        err: error,
        level: alarm ? "ERROR" : "WARN",
        timestamp: expect.any(String),
      })
      expect(errorLogs[0]?.annotations).toEqual(annotations)
      expect(entries.filter((entry) => entry.level === "ERROR")).toHaveLength(
        alarm ? 1 : 0,
      )
      const fieldLogs = resolverLogs.filter(
        (entry) =>
          Array.isArray(entry.message) &&
          entry.message[0] === "GraphQL field failure",
      )
      expect(fieldLogs).toEqual(
        authenticated
          ? [
              expect.objectContaining({
                level: alarm ? "ERROR" : "WARN",
                annotations: identity,
                message: [
                  "GraphQL field failure",
                  expect.objectContaining({
                    field: query?.slice(2, -2),
                    traceId: expect.any(String),
                    userId: identity.userId,
                    error: expect.any(Object),
                  }),
                ],
              }),
            ]
          : [],
      )
    }
  } finally {
    stdout.mockRestore()
    if (previousFunctionName === undefined) {
      delete process.env["AWS_LAMBDA_FUNCTION_NAME"]
    } else {
      process.env["AWS_LAMBDA_FUNCTION_NAME"] = previousFunctionName
    }
    await runtime.dispose()
    await jwks.stop(true)
  }
})
