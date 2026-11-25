import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { NodeFileSystem } from "@effect/platform-node"
import { DateTime, Effect, Layer, ManagedRuntime, Schema } from "effect"
import { createSchema, createYoga } from "graphql-yoga"
import {
  LocalCedarAuthorizationLive,
  LocalCedarConfig,
  getDefaultPoliciesPath,
  getDefaultSchemaPath,
} from "@pf/auth-local-cedar"
import * as dbSchema from "@pf/drizzle-sqlite"
import {
  ExecutionQueries,
  SYSTEM_STEP_EXECUTION_QUEUE,
} from "@pf/graphql-db-operations"
import { systemStepExecutionHandler } from "@pf/job-handler"
import { storeOrganisation } from "@pf/org-to-db"
import {
  ConditionEvaluator,
  NodeStep,
  Organisation,
  OrganisationProviderTest,
  Process,
  ScheduleEvaluator,
  SystemStepExecutor,
  makeConditionEvaluator,
  makeScheduleEvaluator,
  makeSystemStepExecutor,
} from "@pf/process"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite/test"
import { transformSchemaWithAuthDirective } from "../../../../packages/graphql-api/src/lib/auth-directive-plugin"
import { createResolverExecutor } from "../../../../packages/graphql-api/src/lib/resolver-utils"
import { systemSchema } from "../../../../packages/graphql-api/src/lib/system-resolvers"
import type { UserContext } from "../../../../packages/graphql-api/src/lib/types"
import { sqliteDbCase } from "../test-support/graphql-db-matrix"
import {
  type EnqueuedJob,
  makeQueueLayer,
} from "../test-support/queue-auth-stubs"
import { expect, test } from "bun:test"

// The CLI/API/worker boundary proves a restart resumes the persisted execution.
// Queue delivery is driven explicitly; browser login and JWT issuance are excluded.
test("pforg restarts a failed execution through Yoga/Cedar and the runtime worker", async () => {
  const root = mkdtempSync(join(tmpdir(), "restart-cli-db-"))
  let configured = false
  let attempts = 0
  const org = new Organisation({ name: "CLI Restart" })
  const processModel = new Process(org, "retry", {
    name: "Retry",
    purpose: "CLI recovery",
  })
  const start = new NodeStep(processModel, "start", {
    input: () => Effect.succeed({}),
    output: { recovered: Schema.Boolean },
    execute: () =>
      Effect.gen(function* () {
        attempts++
        if (!configured)
          return yield* Effect.fail({
            _tag: "ConfigurationError",
            message: "Retry configuration missing",
          })
        return { recovered: true }
      }),
  })
  const done = new NodeStep(processModel, "done", {
    input: () => Effect.succeed({}),
    output: {},
    execute: () => Effect.succeed({}),
  })
  processModel.start(start).next(done).end()
  const jobs: EnqueuedJob[] = []
  const runtimeLayer = Layer.mergeAll(
    sqliteDbCase.layer,
    NodeFileSystem.layer,
    makeQueueLayer(jobs),
    OrganisationProviderTest(org),
    Layer.succeed(ConditionEvaluator, makeConditionEvaluator(org)),
    Layer.succeed(ScheduleEvaluator, makeScheduleEvaluator(org)),
    Layer.succeed(SystemStepExecutor, makeSystemStepExecutor(org)),
    LocalCedarAuthorizationLive.pipe(
      Layer.provide(
        Layer.succeed(LocalCedarConfig, {
          schemaText: readFileSync(getDefaultSchemaPath(), "utf8"),
          policiesText: [
            readFileSync(getDefaultPoliciesPath(), "utf8"),
            'permit(principal == PF::ProviderUser::"operator@example.com", action == PF::Action::"restart", resource);',
          ],
        }),
      ),
    ),
  )
  const runtime = ManagedRuntime.make(runtimeLayer)
  const context: UserContext = {
    userId: "operator@example.com",
    _requestTime: DateTime.nowUnsafe(),
    _userDetails: { id: "operator@example.com", by: "operator@example.com" },
    jwt: {
      mode: "access",
      type: "user",
      properties: {
        userId: "operator@example.com",
        email: "operator@example.com",
        roles: ["/Operator"],
        orgUnitId: "/",
        orgUnitPath: "/",
      },
      aud: "graphql-api",
      iss: "test",
      sub: "operator@example.com",
      exp: 0,
      iat: 0,
    },
  }
  let server: ReturnType<typeof Bun.serve> | undefined
  try {
    const payload = await runtime.runPromise(
      Effect.gen(function* () {
        yield* storeOrganisation(org)
        const db = yield* TypedSqliteDrizzle
        const steps = yield* db.select().from(dbSchema.step)
        const step = steps.find((row) => row.path.endsWith("/start"))!
        const processes = yield* db.select().from(dbSchema.process)
        yield* db.insert(dbSchema.processState).values({
          id: "retry-state",
          processId: processes[0]!.id,
          startStepId: step.id,
          state: {},
        })
        yield* db
          .insert(dbSchema.processExecution)
          .values({ id: "retry-execution", processStateId: "retry-state" })
        return {
          startsProcess: true as const,
          processExecutionId: "retry-execution",
          stepId: step.id,
          stepPath: step.path,
        }
      }),
    )
    const runJob = (jobId: string) =>
      runtime.runPromise(
        // The worker exposes unknown requirements for arbitrary authored code.
        // This fixture's authored steps require no services beyond this layer.
        systemStepExecutionHandler.handle({
          jobId,
          receipt: jobId,
          queue: SYSTEM_STEP_EXECUTION_QUEUE,
          payload,
          attempts: 1,
          maxAttempts: 1,
          availableAt: DateTime.nowUnsafe(),
          lockedUntil: DateTime.nowUnsafe(),
        }) as Effect.Effect<
          unknown,
          unknown,
          Layer.Success<typeof runtimeLayer>
        >,
      )
    await runJob("initial-attempt")
    const status = () =>
      runtime.runPromise(
        Effect.gen(function* () {
          return (yield* (yield* ExecutionQueries).getExecutions([
            payload.processExecutionId,
          ]))[0]
        }),
      )
    expect((await status())?.status).toBe("Failed")
    expect(attempts).toBe(1)
    configured = true
    jobs.length = 0

    const system = await runtime.runPromise(systemSchema)
    const yoga = createYoga({
      schema: transformSchemaWithAuthDirective(
        createSchema<UserContext>({
          typeDefs: [
            readFileSync(
              new URL(
                "../../../../packages/graphql-schema/graphql/rxdb.graphql",
                import.meta.url,
              ),
              "utf8",
            ),
            system.typeDefs,
          ],
          resolvers: system.resolvers,
        }),
        createResolverExecutor(runtime),
      ),
      context: () => context,
      logging: false,
    })
    server = Bun.serve({ port: 0, fetch: (request) => yoga.fetch(request) })
    writeFileSync(
      join(root, ".graphql-port.json"),
      JSON.stringify({ port: server.port }),
    )
    writeFileSync(
      join(root, "credentials.json"),
      JSON.stringify({
        version: 1,
        baseUrl: "http://localhost:3000",
        accessToken: "fixture-provider-user",
        expiresAt: "2999-01-01T00:00:00.000Z",
        loginAt: "2026-01-01T00:00:00.000Z",
      }),
    )
    const child = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, "../../../../cli/pforg/src/main.ts"),
        "executions",
        "restart",
        payload.processExecutionId,
      ],
      {
        env: {
          ...process.env,
          PF_RUNTIME_ROOT: root,
          PFORG_CREDENTIALS_PATH: join(root, "credentials.json"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
    expect(JSON.parse(stdout)).toEqual({
      success: true,
      restartedCount: 1,
      error: null,
    })
    expect((await status())?.status).toBe("Running")
    const retries = jobs.filter(
      (job) => job.queue === SYSTEM_STEP_EXECUTION_QUEUE,
    )
    expect(retries).toHaveLength(1)
    expect(retries[0]!.payload).toEqual(payload)
    await runJob("retry-attempt")
    expect(attempts).toBe(2)
    await runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* TypedSqliteDrizzle
        const executions = yield* db.select().from(dbSchema.processExecution)
        expect(executions.map((row) => row.id)).toEqual([
          payload.processExecutionId,
        ])
        const states = yield* db.select().from(dbSchema.processState)
        expect(states[0]!.state).toEqual({ recovered: true })
        const flows = yield* db.select().from(dbSchema.scheduledFlow)
        expect(flows).toHaveLength(1)
        expect(flows[0]!.processExecutionId).toBe(payload.processExecutionId)
      }),
    )
  } finally {
    server?.stop(true)
    await runtime.dispose()
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
