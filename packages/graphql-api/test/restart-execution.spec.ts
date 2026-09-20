import { FileSystem } from "@effect/platform"
import { SqlClient } from "@effect/sql"
import { eq } from "drizzle-orm"
import {
  DateTime,
  Schema as ES,
  Effect,
  type Effect as EffectType,
  FiberRef,
  Layer,
  Option,
} from "effect"
import { AuthorizationService } from "@pf/auth-policy"
import * as schema from "@pf/drizzle-sqlite"
import {
  CompletedJobOperations,
  FlowExecutionOperations,
  SYSTEM_STEP_EXECUTION_QUEUE,
  StepCompletionOperations,
  UserDetails,
  type UserDetailsValue,
  getStartedSystemStepCompletedJobId,
} from "@pf/graphql-db-operations"
import { systemStepExecutionHandler } from "@pf/job-handler"
import { storeOrganisation } from "@pf/org-to-db"
import {
  type AuthorTaggedError,
  ConditionEvaluator,
  Form,
  NodeStep,
  Organisation,
  OrganisationProviderTest,
  Process,
  Role,
  ScheduleEvaluator,
  SystemStepExecutor,
  makeConditionEvaluator,
  makeScheduleEvaluator,
  makeSystemStepExecutor,
} from "@pf/process"
import { EnqueueError, type Job, QueueService } from "@pf/queue-service"
import { RequestTime } from "@pf/request-time"
import {
  DatabaseTest,
  TypedSqliteDrizzle,
} from "@pf/service-drizzle-sqlite/test"
import {
  SqliteCompletedJobOperationsLive,
  SqliteDbOperationsLive,
  SqliteFlowExecutionOperationsLive,
  SqliteGraphqlDbOperationsLive,
  SqliteScheduledFlowOperationsLive,
} from "@pf/sqlite-operations"
import { systemStartRestartDispatchId } from "../src/lib/execution-restart"
import { DynamicSchemaConfig } from "../src/lib/graphql-api"
import { systemSchema } from "../src/lib/system-resolvers"
import type { UserContext } from "../src/lib/types"
import { describe, expect, it } from "bun:test"

interface EnqueuedJob {
  queue: string
  payload: unknown
  logicalJobId?: string
  retryLimit?: number
}

const createMockQueueService = (options?: {
  readonly acceptedButResponseLostAttempts?: readonly number[]
  readonly failEnqueueAttempts?: readonly number[]
  readonly queueInTransaction?: boolean
}) => {
  const enqueuedJobs: EnqueuedJob[] = []
  let enqueueAttempts = 0
  const layer = Layer.succeed(QueueService, {
    queueInTransaction: options?.queueInTransaction ?? true,
    enqueue: (queue, payload, enqueueOptions) =>
      Effect.gen(function* () {
        enqueueAttempts += 1
        const acceptedButResponseLost =
          options?.acceptedButResponseLostAttempts?.includes(enqueueAttempts) ??
          false
        if (acceptedButResponseLost) {
          enqueuedJobs.push({
            queue,
            payload,
            ...(enqueueOptions?.logicalJobId
              ? { logicalJobId: enqueueOptions.logicalJobId }
              : {}),
            ...(enqueueOptions?.retryLimit !== undefined
              ? { retryLimit: enqueueOptions.retryLimit }
              : {}),
          })
        }
        if (
          acceptedButResponseLost ||
          options?.failEnqueueAttempts?.includes(enqueueAttempts)
        ) {
          return yield* new EnqueueError({
            queue,
            message: "Simulated enqueue failure",
          })
        }
        enqueuedJobs.push({
          queue,
          payload,
          ...(enqueueOptions?.logicalJobId
            ? { logicalJobId: enqueueOptions.logicalJobId }
            : {}),
          ...(enqueueOptions?.retryLimit !== undefined
            ? { retryLimit: enqueueOptions.retryLimit }
            : {}),
        })
        return `mock-job-${enqueuedJobs.length}`
      }),
    enqueueWithDelay: () => Effect.dieMessage("not used"),
    rawClaim: () => Effect.succeed(Option.none()),
    acknowledge: () => Effect.dieMessage("not used"),
    fail: () => Effect.dieMessage("not used"),
    extendVisibility: () => Effect.dieMessage("not used"),
    getStats: () => Effect.dieMessage("not used"),
  })
  return { layer, enqueuedJobs }
}

const makeStartSystemStepOrg = (
  executeEffect: EffectType.Effect<
    { greeting: string },
    AuthorTaggedError,
    unknown
  >,
  options?: { readonly retries?: number },
) => {
  const org = new Organisation({ name: "RestartTestOrg" })
  const process = new Process(org, "restart-start-system", {
    name: "Restart Start System",
    purpose: "System-start restart tests",
  })

  const hello = new NodeStep(process, "hello", {
    name: "Hello",
    purpose: "Start system step",
    input: () => Effect.succeed({}),
    output: { greeting: ES.String },
    execute: () => executeEffect,
    ...(options?.retries !== undefined ? { retries: options.retries } : {}),
  })

  const done = new NodeStep(process, "done", {
    name: "Done",
    purpose: "Terminal system step",
    input: () => Effect.succeed({}),
    output: {},
    execute: () => Effect.succeed({}),
  })

  process.start(hello).next(done).end()

  return { org, hello, done }
}

const makeAuthorizationService = (): AuthorizationService["Type"] => ({
  canIssueDelegationSecret: () => Effect.succeed(false),
  canListDelegationTokens: () => Effect.succeed(false),
  canManageDelegation: () => Effect.succeed(false),
  canLogin: () => Effect.succeed(true),
  canCompleteStep: () => Effect.succeed(true),
  canCompleteTodo: () => Effect.succeed(true),
  canCorrectPublicCompletionTodo: () => Effect.succeed(false),
  canCompletePublicTodo: () => Effect.succeed(false),
  canRequestRole: () => Effect.succeed(false),
  canRequestProviderUserPermissions: () => Effect.succeed(false),
  canActOnBehalfOf: () => Effect.succeed(false),
  canViewExecution: () => Effect.succeed(true),
  canRestartExecution: () => Effect.succeed(true),
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

const createTestLayers = (
  org: Organisation,
  queueOptions?: Parameters<typeof createMockQueueService>[0],
) => {
  const { layer: mockQueueServiceLayer, enqueuedJobs } =
    createMockQueueService(queueOptions)
  const RequestTimeLive = Layer.succeed(
    RequestTime,
    FiberRef.unsafeMake(DateTime.unsafeMake(Date.now())),
  )
  const UserDetailsLive = Layer.succeed(
    UserDetails,
    FiberRef.unsafeMake({
      by: "TEST_USER",
      id: "TEST_USER",
    }) as FiberRef.FiberRef<UserDetailsValue>,
  )
  const ConditionEvaluatorLive = Layer.succeed(
    ConditionEvaluator,
    makeConditionEvaluator(org),
  )
  const ScheduleEvaluatorLive = Layer.succeed(
    ScheduleEvaluator,
    makeScheduleEvaluator(org),
  )
  const SystemStepExecutorLive = Layer.succeed(
    SystemStepExecutor,
    makeSystemStepExecutor(org),
  )

  const BaseDbLayer = Layer.provideMerge(SqliteDbOperationsLive, DatabaseTest)
  const OperationLayers = Layer.provideMerge(
    Layer.mergeAll(
      SqliteFlowExecutionOperationsLive,
      SqliteScheduledFlowOperationsLive,
      SqliteCompletedJobOperationsLive,
      SqliteGraphqlDbOperationsLive,
    ),
    BaseDbLayer,
  )

  const layers = Layer.mergeAll(
    RequestTimeLive,
    UserDetailsLive,
    ConditionEvaluatorLive,
    ScheduleEvaluatorLive,
    SystemStepExecutorLive,
    OrganisationProviderTest(org),
    Layer.succeed(AuthorizationService, makeAuthorizationService()),
    Layer.succeed(FileSystem.FileSystem, {
      exists: () => Effect.succeed(true),
      readFileString: () => Effect.succeed("type Query { _: Boolean }"),
    } as unknown as FileSystem.FileSystem),
    Layer.succeed(DynamicSchemaConfig, { schemaPath: "/tmp/org.graphql" }),
    mockQueueServiceLayer,
    OperationLayers,
    BaseDbLayer,
  )

  return { layers, enqueuedJobs }
}

const insertFailedSystemStartExecution = Effect.gen(function* () {
  const db = yield* TypedSqliteDrizzle
  const flowExecutionOps = yield* FlowExecutionOperations
  const completedJobOps = yield* CompletedJobOperations

  const steps = yield* db.select().from(schema.step)
  const startStep = steps.find((step) => step.path.endsWith("/hello"))
  if (!startStep) throw new Error("Start system step not found")

  const processes = yield* db.select().from(schema.process)
  const process = processes[0]
  if (!process) throw new Error("Process not found")

  const processStateId = "pst-restart-system-start-001"
  yield* db.insert(schema.processState).values({
    id: processStateId,
    processId: process.id,
    startStepId: startStep.id,
    state: {},
  })

  const processExecutionId = "pex-restart-system-start-001"
  yield* db.insert(schema.processExecution).values({
    id: processExecutionId,
    processStateId,
  })

  yield* flowExecutionOps.setProcessExecutionFailed(
    processExecutionId,
    "collection boom",
  )
  yield* completedJobOps.markJobCompleted(
    SYSTEM_STEP_EXECUTION_QUEUE,
    getStartedSystemStepCompletedJobId(processExecutionId),
  )

  return {
    processExecutionId,
    stepId: startStep.id,
    stepPath: startStep.path,
    processId: process.id,
  }
})

const makeContext = (): UserContext => ({
  _requestTime: DateTime.unsafeMake("2026-04-06T10:00:00.000Z"),
  _userDetails: {
    by: "starter@example.com",
    id: "starter@example.com",
  } as UserContext["_userDetails"],
  jwt: {
    mode: "access",
    type: "user",
    properties: {
      userId: "starter@example.com",
      email: "starter@example.com",
      roles: ["/Administrator"],
      orgUnitPath: "/",
      orgUnitId: "/",
    },
    aud: "graphql-api",
    iss: "http://localhost:4020",
    sub: "starter@example.com",
    exp: 0,
    iat: 0,
  },
  userId: "starter@example.com",
})

const callRestartExecution = (executionId: string) =>
  Effect.gen(function* () {
    const schemaResult = yield* systemSchema
    const resolver = (schemaResult.resolvers?.Mutation?.["restartExecution"] ??
      (() => Effect.dieMessage("Missing restartExecution resolver"))) as (
      parent: unknown,
      args: { executionId: string },
      context: UserContext,
    ) => Effect.Effect<
      {
        success: boolean
        restartedCount: number
        error: string | null
      },
      unknown,
      never
    >

    return yield* resolver(undefined, { executionId }, makeContext())
  })

const runStartJob = (params: {
  readonly processExecutionId: string
  readonly stepId: string
  readonly stepPath: string
  readonly jobId: string
  readonly attempts?: number
  readonly maxAttempts?: number
}) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now
    const job: Job<{
      startsProcess: true
      processExecutionId: string
      stepId: string
      stepPath: string
    }> = {
      jobId: params.jobId,
      receipt: `receipt-${params.jobId}`,
      queue: SYSTEM_STEP_EXECUTION_QUEUE,
      payload: {
        startsProcess: true,
        processExecutionId: params.processExecutionId,
        stepId: params.stepId,
        stepPath: params.stepPath,
      },
      attempts: params.attempts ?? 1,
      maxAttempts: params.maxAttempts ?? 5,
      availableAt: now,
      lockedUntil: now,
    }
    yield* systemStepExecutionHandler.handle(job)
  })

describe("restartExecution for failed system-start executions", () => {
  it("reopens a Todo-less failed system start and creates downstream flow", async () => {
    const { org } = makeStartSystemStepOrg(
      Effect.succeed({ greeting: "hello" }),
      { retries: 3 },
    )
    const { layers, enqueuedJobs } = createTestLayers(org)

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* storeOrganisation(org)
        const { processExecutionId, stepId, stepPath } =
          yield* insertFailedSystemStartExecution

        const result = yield* callRestartExecution(processExecutionId)
        expect(result).toEqual({
          success: true,
          restartedCount: 1,
          error: null,
        })

        const db = yield* TypedSqliteDrizzle
        const executions = yield* db
          .select({
            finishedAt: schema.processExecution.finishedAt,
            abandonedAt: schema.processExecution.abandonedAt,
            abandonedReason: schema.processExecution.abandonedReason,
            businessDuration: schema.processExecution.businessDuration,
          })
          .from(schema.processExecution)
          .where(eq(schema.processExecution.id, processExecutionId))
        expect(executions[0]?.finishedAt).toBeNull()
        expect(executions[0]?.abandonedAt).toBeNull()
        expect(executions[0]?.abandonedReason).toBeNull()
        expect(executions[0]?.businessDuration).toBeNull()

        const completedJobOps = yield* CompletedJobOperations
        expect(
          yield* completedJobOps.isJobCompleted(
            SYSTEM_STEP_EXECUTION_QUEUE,
            getStartedSystemStepCompletedJobId(processExecutionId),
          ),
        ).toBe(false)

        const startJobs = enqueuedJobs.filter(
          (job) => job.queue === SYSTEM_STEP_EXECUTION_QUEUE,
        )
        expect(startJobs).toHaveLength(1)
        expect(startJobs[0]?.payload).toEqual({
          startsProcess: true,
          processExecutionId,
          stepId,
          stepPath,
        })
        expect(startJobs[0]?.logicalJobId).toMatch(
          new RegExp(
            `^system-step:start-restart:${processExecutionId}:[0-9a-f-]+$`,
          ),
        )
        // Configured step retry limit from org hydration (retries: 3).
        expect(startJobs[0]?.retryLimit).toBe(3)

        yield* runStartJob({
          processExecutionId,
          stepId,
          stepPath,
          jobId: "job-restart-success-001",
        })

        const scheduledFlows = yield* db
          .select({
            processExecutionId: schema.scheduledFlow.processExecutionId,
            sourceStepId: schema.scheduledFlow.sourceStepId,
          })
          .from(schema.scheduledFlow)
          .where(
            eq(schema.scheduledFlow.processExecutionId, processExecutionId),
          )
        expect(scheduledFlows).toEqual([
          { processExecutionId, sourceStepId: stepId },
        ])

        expect(
          yield* completedJobOps.isJobCompleted(
            SYSTEM_STEP_EXECUTION_QUEUE,
            getStartedSystemStepCompletedJobId(processExecutionId),
          ),
        ).toBe(true)
      }).pipe(Effect.provide(layers)) as Effect.Effect<void>,
    )
  })

  it("supports a second failure and second manual restart with a new attempt id", async () => {
    let failNext = true
    const { org } = makeStartSystemStepOrg(
      Effect.gen(function* () {
        if (failNext) {
          failNext = false
          return yield* Effect.fail({
            _tag: "TestFailure",
            message: "still broken",
          })
        }
        return { greeting: "recovered" }
      }),
    )
    const { layers, enqueuedJobs } = createTestLayers(org)

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* storeOrganisation(org)
        const { processExecutionId, stepId, stepPath } =
          yield* insertFailedSystemStartExecution

        const first = yield* callRestartExecution(processExecutionId)
        expect(first.success).toBe(true)

        const firstLogicalJobId = enqueuedJobs.find(
          (job) => job.queue === SYSTEM_STEP_EXECUTION_QUEUE,
        )?.logicalJobId
        expect(firstLogicalJobId).toBeDefined()

        // Exhaust retries to re-fail the system start.
        yield* runStartJob({
          processExecutionId,
          stepId,
          stepPath,
          jobId: "job-restart-fail-again",
          attempts: 5,
          maxAttempts: 5,
        })

        const db = yield* TypedSqliteDrizzle
        const failedAgain = yield* db
          .select({
            abandonedReason: schema.processExecution.abandonedReason,
            finishedAt: schema.processExecution.finishedAt,
          })
          .from(schema.processExecution)
          .where(eq(schema.processExecution.id, processExecutionId))
        expect(failedAgain[0]?.finishedAt).not.toBeNull()
        expect(failedAgain[0]?.abandonedReason).toContain("still broken")

        enqueuedJobs.length = 0
        const second = yield* callRestartExecution(processExecutionId)
        expect(second).toEqual({
          success: true,
          restartedCount: 1,
          error: null,
        })

        const secondLogicalJobId = enqueuedJobs.find(
          (job) => job.queue === SYSTEM_STEP_EXECUTION_QUEUE,
        )?.logicalJobId
        expect(secondLogicalJobId).toBeDefined()
        expect(secondLogicalJobId).not.toBe(firstLogicalJobId)

        yield* runStartJob({
          processExecutionId,
          stepId,
          stepPath,
          jobId: "job-restart-success-002",
        })

        const states = yield* db
          .select({ state: schema.processState.state })
          .from(schema.processState)
          .where(eq(schema.processState.id, "pst-restart-system-start-001"))
        expect(states[0]?.state).toEqual({ greeting: "recovered" })
      }).pipe(Effect.provide(layers)) as Effect.Effect<void>,
    )
  })

  it("deduplicates concurrent restart requests to a single active attempt", async () => {
    const { org } = makeStartSystemStepOrg(Effect.succeed({ greeting: "hi" }))
    const { layers, enqueuedJobs } = createTestLayers(org)

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* storeOrganisation(org)
        const { processExecutionId } = yield* insertFailedSystemStartExecution

        const [first, second] = yield* Effect.all(
          [
            callRestartExecution(processExecutionId),
            callRestartExecution(processExecutionId),
          ],
          { concurrency: "unbounded" },
        )

        expect(first.success).toBe(true)
        expect(second.success).toBe(true)

        const startJobs = enqueuedJobs.filter(
          (job) => job.queue === SYSTEM_STEP_EXECUTION_QUEUE,
        )
        expect(startJobs).toHaveLength(1)

        const sql = yield* SqlClient.SqlClient
        // Execution remains open once (not double-cleared into a weird state).
        const executions = yield* sql`
          SELECT finished_at, abandoned_reason
          FROM pf_process_execution
          WHERE id = ${processExecutionId}
        `
        expect(executions[0]?.["finished_at"]).toBeNull()
        expect(executions[0]?.["abandoned_reason"]).toBeNull()
      }).pipe(Effect.provide(layers)) as Effect.Effect<void>,
    )
  })

  for (const ambiguity of [false, true]) {
    it(`recovers external-queue restart via GraphQL after ${ambiguity ? "an accepted response is lost" : "a post-commit enqueue failure"}`, async () => {
      const { org } = makeStartSystemStepOrg(
        Effect.succeed({ greeting: "external" }),
      )
      const { layers, enqueuedJobs } = createTestLayers(org, {
        queueInTransaction: false,
        ...(ambiguity
          ? { acceptedButResponseLostAttempts: [1] }
          : { failEnqueueAttempts: [1] }),
      })

      await Effect.runPromise(
        Effect.gen(function* () {
          yield* storeOrganisation(org)
          const { processExecutionId, stepId, stepPath } =
            yield* insertFailedSystemStartExecution

          // Production path: GraphQL mutation, not the helper alone.
          const first = yield* callRestartExecution(processExecutionId).pipe(
            Effect.either,
          )
          expect(first._tag).toBe("Left")

          const db = yield* TypedSqliteDrizzle
          const outboxBefore = yield* db
            .select({ payload: schema.jobQueue.jobPayload })
            .from(schema.jobQueue)
            .where(eq(schema.jobQueue._deleted, false))
          expect(outboxBefore.length).toBeGreaterThan(0)

          const executions = yield* db
            .select({
              finishedAt: schema.processExecution.finishedAt,
              abandonedReason: schema.processExecution.abandonedReason,
            })
            .from(schema.processExecution)
            .where(eq(schema.processExecution.id, processExecutionId))
          // Transaction committed: failure cleared even though SQS send failed.
          // Status is no longer Failed; sequential GraphQL retry must still work.
          expect(executions[0]?.finishedAt).toBeNull()
          expect(executions[0]?.abandonedReason).toBeNull()

          const recovered = yield* callRestartExecution(processExecutionId)
          expect(recovered).toEqual({
            success: true,
            restartedCount: 1,
            error: null,
          })

          const outboxAfter = yield* db
            .select({ id: schema.jobQueue.id })
            .from(schema.jobQueue)
            .where(eq(schema.jobQueue._deleted, false))
          expect(outboxAfter).toEqual([])

          const startJobs = enqueuedJobs.filter(
            (job) => job.queue === SYSTEM_STEP_EXECUTION_QUEUE,
          )
          // Delivery retries share one logical job id for this attempt.
          expect(new Set(startJobs.map((job) => job.logicalJobId)).size).toBe(1)
          expect(startJobs[0]?.payload).toEqual({
            startsProcess: true,
            processExecutionId,
            stepId,
            stepPath,
          })
          expect(
            startJobs.every((job) =>
              String(job.logicalJobId).startsWith(
                `system-step:start-restart:${processExecutionId}:`,
              ),
            ),
          ).toBe(true)

          // Dispatch id remains stable for recovery of the same attempt.
          expect(systemStartRestartDispatchId(processExecutionId)).toBe(
            `execution-restart:${processExecutionId}`,
          )
        }).pipe(Effect.provide(layers)) as Effect.Effect<void>,
      )
    })
  }

  it("reopens again when re-failed with leftover external outbox (no false success)", async () => {
    // Partial drain: start job enqueues, then a later event enqueue fails and
    // leaves outbox rows. Start can re-fail while events remain undrained.
    // Restart must not treat leftover outbox as success without reopen.
    const { org } = makeStartSystemStepOrg(
      Effect.fail({ _tag: "TestFailure", message: "re-failed after restart" }),
    )
    const { layers, enqueuedJobs } = createTestLayers(org, {
      queueInTransaction: false,
      // seq 0 start succeeds; seq 1 execution-event fails → leftover outbox.
      failEnqueueAttempts: [2],
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* storeOrganisation(org)
        const { processExecutionId, stepId, stepPath } =
          yield* insertFailedSystemStartExecution

        const first = yield* callRestartExecution(processExecutionId).pipe(
          Effect.either,
        )
        expect(first._tag).toBe("Left")

        const firstStartLogicalJobId = enqueuedJobs.find(
          (job) => job.queue === SYSTEM_STEP_EXECUTION_QUEUE,
        )?.logicalJobId
        expect(firstStartLogicalJobId).toBeDefined()

        // Simulate: start worker ran and re-failed while event outbox remains.
        const flowExecutionOps = yield* FlowExecutionOperations
        const completedJobOps = yield* CompletedJobOperations
        yield* flowExecutionOps.setProcessExecutionFailed(
          processExecutionId,
          "re-failed after restart",
        )
        yield* completedJobOps.markJobCompleted(
          SYSTEM_STEP_EXECUTION_QUEUE,
          getStartedSystemStepCompletedJobId(processExecutionId),
        )

        const db = yield* TypedSqliteDrizzle
        const leftover = yield* db
          .select({ id: schema.jobQueue.id })
          .from(schema.jobQueue)
          .where(eq(schema.jobQueue._deleted, false))
        expect(leftover.length).toBeGreaterThan(0)

        enqueuedJobs.length = 0
        const second = yield* callRestartExecution(processExecutionId)
        expect(second).toEqual({
          success: true,
          restartedCount: 1,
          error: null,
        })

        // Reopen cleared the re-failure representation.
        const executions = yield* db
          .select({
            finishedAt: schema.processExecution.finishedAt,
            abandonedReason: schema.processExecution.abandonedReason,
          })
          .from(schema.processExecution)
          .where(eq(schema.processExecution.id, processExecutionId))
        expect(executions[0]?.finishedAt).toBeNull()
        expect(executions[0]?.abandonedReason).toBeNull()

        // Completion marker cleared so the new start attempt is not skipped.
        expect(
          yield* completedJobOps.isJobCompleted(
            SYSTEM_STEP_EXECUTION_QUEUE,
            getStartedSystemStepCompletedJobId(processExecutionId),
          ),
        ).toBe(false)

        const secondStartJobs = enqueuedJobs.filter(
          (job) => job.queue === SYSTEM_STEP_EXECUTION_QUEUE,
        )
        expect(secondStartJobs).toHaveLength(1)
        expect(secondStartJobs[0]?.payload).toEqual({
          startsProcess: true,
          processExecutionId,
          stepId,
          stepPath,
        })
        // New attempt-scoped logical id (not a re-drain of the first attempt).
        expect(secondStartJobs[0]?.logicalJobId).toBeDefined()
        expect(secondStartJobs[0]?.logicalJobId).not.toBe(
          firstStartLogicalJobId,
        )
      }).pipe(Effect.provide(layers)) as Effect.Effect<void>,
    )
  })

  it("concurrent external restarts after re-failure enqueue exactly one start job", async () => {
    // Failed + leftover outbox: two overlapping restarts must not discard each
    // other's fresh outbox (stable dispatch id race).
    const { org } = makeStartSystemStepOrg(Effect.succeed({ greeting: "ok" }))
    const { layers, enqueuedJobs } = createTestLayers(org, {
      queueInTransaction: false,
      failEnqueueAttempts: [2],
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* storeOrganisation(org)
        const { processExecutionId } = yield* insertFailedSystemStartExecution

        yield* callRestartExecution(processExecutionId).pipe(Effect.either)

        const flowExecutionOps = yield* FlowExecutionOperations
        const completedJobOps = yield* CompletedJobOperations
        yield* flowExecutionOps.setProcessExecutionFailed(
          processExecutionId,
          "re-failed",
        )
        yield* completedJobOps.markJobCompleted(
          SYSTEM_STEP_EXECUTION_QUEUE,
          getStartedSystemStepCompletedJobId(processExecutionId),
        )

        enqueuedJobs.length = 0
        const [a, b] = yield* Effect.all(
          [
            callRestartExecution(processExecutionId),
            callRestartExecution(processExecutionId),
          ],
          { concurrency: "unbounded" },
        )

        // At least one must fully succeed; neither may leave a jobless reopen.
        expect(a.success || b.success).toBe(true)
        if (!a.success) {
          expect(a.error).toMatch(/retry|dispatch|failed todos/i)
        }
        if (!b.success) {
          expect(b.error).toMatch(/retry|dispatch|failed todos/i)
        }

        const startJobs = enqueuedJobs.filter(
          (job) => job.queue === SYSTEM_STEP_EXECUTION_QUEUE,
        )
        // Exactly one start attempt enqueued (same logical id if concurrent drain).
        expect(startJobs.length).toBeGreaterThanOrEqual(1)
        expect(new Set(startJobs.map((job) => job.logicalJobId)).size).toBe(1)

        const db = yield* TypedSqliteDrizzle
        const executions = yield* db
          .select({
            finishedAt: schema.processExecution.finishedAt,
            abandonedReason: schema.processExecution.abandonedReason,
          })
          .from(schema.processExecution)
          .where(eq(schema.processExecution.id, processExecutionId))
        expect(executions[0]?.finishedAt).toBeNull()
        expect(executions[0]?.abandonedReason).toBeNull()

        expect(
          yield* completedJobOps.isJobCompleted(
            SYSTEM_STEP_EXECUTION_QUEUE,
            getStartedSystemStepCompletedJobId(processExecutionId),
          ),
        ).toBe(false)

        const outbox = yield* db
          .select({ id: schema.jobQueue.id })
          .from(schema.jobQueue)
          .where(eq(schema.jobQueue._deleted, false))
        expect(outbox).toEqual([])
      }).pipe(Effect.provide(layers)) as Effect.Effect<void>,
    )
  })

  it("does not clear genuine abandonment when reopening system-start failure", async () => {
    const { org } = makeStartSystemStepOrg(Effect.succeed({ greeting: "x" }))
    const { layers } = createTestLayers(org)

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* storeOrganisation(org)
        const { processExecutionId } = yield* insertFailedSystemStartExecution
        const db = yield* TypedSqliteDrizzle
        const stepCompletionOps = yield* StepCompletionOperations

        // Convert to a genuine user abandonment after the system-start failure
        // representation was recorded.
        yield* stepCompletionOps.setProcessExecutionAbandoned(
          processExecutionId,
          "user cancelled",
        )

        // Abandoned rows keep abandonedAt; reopen must not match.
        const reopened =
          yield* stepCompletionOps.reopenFailedSystemStartExecution(
            processExecutionId,
          )
        expect(reopened).toBe(false)

        const rows = yield* db
          .select({
            abandonedAt: schema.processExecution.abandonedAt,
            abandonedReason: schema.processExecution.abandonedReason,
            finishedAt: schema.processExecution.finishedAt,
          })
          .from(schema.processExecution)
          .where(eq(schema.processExecution.id, processExecutionId))
        expect(rows[0]?.abandonedAt).not.toBeNull()
        expect(rows[0]?.abandonedReason).toBe("user cancelled")
        expect(rows[0]?.finishedAt).not.toBeNull()
      }).pipe(Effect.provide(layers)) as Effect.Effect<void>,
    )
  })
})

const makeTodoBackedSystemStepOrg = () => {
  const org = new Organisation({ name: "RestartTodoOrg" })
  const employee = new Role(org, "employee", { name: "Employee" })
  const process = new Process(org, "restart-todo-system", {
    name: "Restart Todo System",
    purpose: "Todo-backed system-step restart tests",
  })

  const submit = new Form(process, "submit", {
    name: "Submit",
    role: employee,
    form: () => ({}),
  })
  const automate = new NodeStep(process, "automate", {
    name: "Automate",
    input: () => Effect.succeed({}),
    output: {},
    execute: () =>
      Effect.fail({ _tag: "TestFailure", message: "account boom" }),
  })

  process.start(submit).next(automate).end()

  return { org }
}

const insertFailedTodoBackedSystemExecution = Effect.gen(function* () {
  const db = yield* TypedSqliteDrizzle
  const flowExecutionOps = yield* FlowExecutionOperations

  const steps = yield* db.select().from(schema.step)
  const systemStep = steps.find((step) => step.roleId == null)
  if (!systemStep) throw new Error("System step not found")

  const flows = yield* db.select().from(schema.flow)
  const flowToSystem = flows.find((flow) => flow.targetStepId === systemStep.id)
  if (!flowToSystem) throw new Error("Flow to system step not found")

  const processes = yield* db.select().from(schema.process)
  const process = processes[0]
  if (!process) throw new Error("Process not found")

  const processStateId = "pst-restart-todo-system-001"
  yield* db.insert(schema.processState).values({
    id: processStateId,
    processId: process.id,
    startStepId: flowToSystem.sourceStepId,
    state: {},
  })

  const processExecutionId = "pex-restart-todo-system-001"
  yield* db.insert(schema.processExecution).values({
    id: processExecutionId,
    processStateId,
  })

  const todoId = "todo-restart-todo-system-001"
  yield* db.insert(schema.toDo).values({
    id: todoId,
    processExecutionId,
    flowId: flowToSystem.id,
    failureReason: "account boom",
  })

  yield* flowExecutionOps.setProcessExecutionFailed(
    processExecutionId,
    "account boom",
  )

  return { processExecutionId, todoId, stepPath: systemStep.path }
})

describe("restartExecution for failed todo-backed system steps", () => {
  it("reopens a Failed execution and clears the execution-level failure reason", async () => {
    const { org } = makeTodoBackedSystemStepOrg()
    const { layers, enqueuedJobs } = createTestLayers(org)

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* storeOrganisation(org)
        const { processExecutionId, todoId } =
          yield* insertFailedTodoBackedSystemExecution

        const result = yield* callRestartExecution(processExecutionId)
        expect(result).toEqual({
          success: true,
          restartedCount: 1,
          error: null,
        })

        const db = yield* TypedSqliteDrizzle
        const executions = yield* db
          .select({
            finishedAt: schema.processExecution.finishedAt,
            abandonedAt: schema.processExecution.abandonedAt,
            abandonedReason: schema.processExecution.abandonedReason,
          })
          .from(schema.processExecution)
          .where(eq(schema.processExecution.id, processExecutionId))
        expect(executions[0]?.finishedAt).toBeNull()
        expect(executions[0]?.abandonedAt).toBeNull()
        expect(executions[0]?.abandonedReason).toBeNull()

        const todos = yield* db
          .select({ failureReason: schema.toDo.failureReason })
          .from(schema.toDo)
          .where(eq(schema.toDo.id, todoId))
        expect(todos[0]?.failureReason).toBeNull()

        expect(
          enqueuedJobs.some((job) => job.queue === SYSTEM_STEP_EXECUTION_QUEUE),
        ).toBe(true)
      }).pipe(Effect.provide(layers)) as Effect.Effect<void>,
    )
  })
})
