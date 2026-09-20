import { randomUUID } from "node:crypto"
import { FileSystem } from "@effect/platform"
import { DateTime, Effect, Layer } from "effect"
import type { StepResource } from "@pf/auth-policy"
import {
  type UserContext,
  startProcessExecution,
  systemSchema,
} from "@pf/graphql-api"
import {
  EXECUTION_EVENT_QUEUE,
  ExecutionQueries,
  FlowExecutionOperations,
  PROCESS_EVENT_QUEUE,
  ScheduledFlowOperations,
  StepCompletionOperations,
  TODO_EVENT_QUEUE,
} from "@pf/graphql-db-operations"
import {
  Form,
  NodeStep,
  OrgUnit,
  Organisation,
  Process,
  Role,
  normalizePath,
} from "@pf/process"
import {
  type GraphqlDbCase,
  postgresDbCase,
  seedActiveTodo,
  sqliteDbCase,
} from "../test-support/graphql-db-matrix"
import {
  type EnqueuedJob,
  makeAuthorizationLayer,
  makeQueueLayer,
} from "../test-support/queue-auth-stubs"
import { describe, expect, it } from "bun:test"

const uniqueSuffix = () => randomUUID().slice(0, 8)
const runPostgresDbSpecs =
  process.env["PF_RUNTIME_LOCAL_POSTGRES_DB_SPECS"] === "1"

interface AbandonTestResult {
  readonly abandonResult: { success: boolean; error: string | null }
  readonly executionStatus: string | undefined
  readonly abandonedReason: string | null | undefined
  readonly abandonedAt?: DateTime.Utc | null
  readonly scheduledFlowIds: string[]
  readonly todoDeleted?: boolean
  readonly todoFailureReason?: string | null
  readonly todoId?: string
  readonly started: { executionId: string; processId?: string }
}

const fileSystemLayer = Layer.succeed(FileSystem.FileSystem, {
  readFileString: () => Effect.succeed("type Query { _: Boolean }"),
} as unknown as FileSystem.FileSystem)

const makeContext = (rolePath: string, orgUnitPath: string): UserContext => ({
  _requestTime: DateTime.unsafeMake("2026-04-13T10:00:00.000Z"),
  _userDetails: {
    by: "employee@example.com",
    id: "employee@example.com",
  } as UserContext["_userDetails"],
  jwt: {
    mode: "access",
    type: "user",
    properties: {
      userId: "employee@example.com",
      email: "employee@example.com",
      roles: [rolePath],
      orgUnitPath,
      orgUnitId: orgUnitPath,
    },
    aud: "graphql-api",
    iss: "http://localhost:4020",
    sub: "employee@example.com",
    exp: 0,
    iat: 0,
  },
  userId: "employee@example.com",
})

const makeAbandonAuthorizationLayer = (
  authorizedStepPaths: string[],
  authorize = true,
) =>
  makeAuthorizationLayer({
    canAbandonStep: (_principal, resource: StepResource) =>
      Effect.sync(() => {
        authorizedStepPaths.push(resource.uid.id)
        return authorize
      }),
  })

const makePendingFlowOrganisation = (suffix: string) => {
  const org = new Organisation({ name: `Abandon Org ${suffix}` })
  const operations = new OrgUnit(org, `Abandon Ops ${suffix}`, {
    name: `Abandon Ops ${suffix}`,
    type: "department",
  })
  const employee = new Role(operations, "employee", { name: "Employee" })
  const process = new Process(operations, `abandon-${suffix}`, {
    name: `Abandon ${suffix}`,
    purpose: "Test execution abandonment",
  })
  const start = new NodeStep(process, "Start", {
    input: () => Effect.succeed({}),
    output: {},
    execute: () => Effect.succeed({}),
  })
  const startFlow = process.start(start)
  const review = new Form(startFlow, "Review", {
    role: employee,
    form: () => ({}),
  })
  startFlow.next(review).end()

  return {
    org,
    orgUnitPath: normalizePath(operations.node.path),
    rolePath: normalizePath(employee.node.path),
    processPath: normalizePath(process.node.path),
    startStepPath: normalizePath(start.node.path),
    reviewStepPath: normalizePath(review.node.path),
  }
}

const abandonExecutionEffect = (
  executionId: string,
  reason: string | undefined,
  context: UserContext,
) =>
  Effect.gen(function* () {
    const schema = yield* systemSchema
    const resolver = schema.resolvers?.Mutation?.[
      "abandonExecution"
    ] as unknown as (
      parent: unknown,
      args: { executionId: string; reason?: string | null },
      context: UserContext,
    ) => Effect.Effect<{ success: boolean; error: string | null }, unknown>

    return yield* resolver(
      undefined,
      reason === undefined ? { executionId } : { executionId, reason },
      context,
    )
  })

const provideAbandonLayers = <R, A>(
  db: GraphqlDbCase<R>,
  enqueuedJobs: EnqueuedJob[],
  authorizedStepPaths: string[],
  effect: Effect.Effect<A, unknown, unknown>,
  authorize = true,
) =>
  effect.pipe(
    Effect.provide(
      Layer.mergeAll(
        db.layer,
        makeQueueLayer(enqueuedJobs),
        makeAbandonAuthorizationLayer(authorizedStepPaths, authorize),
        fileSystemLayer,
      ),
    ),
  ) as unknown as Effect.Effect<A, unknown, never>

const runSuite = <R>(db: GraphqlDbCase<R>) => {
  describe(`abandonExecution (${db.name})`, () => {
    it("abandons orphaned running executions by authorizing against pending scheduled work", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const authorizedStepPaths: string[] = []
      const seed = makePendingFlowOrganisation(`${db.name}-${uniqueSuffix()}`)

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* db.storeOrganisation(seed.org)
          yield* db.ensureProviderUser({
            email: "employee@example.com",
            rolePaths: [seed.rolePath],
            orgUnitPath: seed.orgUnitPath,
          })
          const processId = yield* db.getProcessIdByPath(seed.processPath)
          const reviewStepId = yield* db.getStepIdByPath(seed.reviewStepPath)
          const started = yield* startProcessExecution(
            processId,
            seed.processPath,
            seed.startStepPath,
            {},
            { enqueueStartSystemStep: true },
          )
          const scheduledFlowOps = yield* ScheduledFlowOperations
          yield* scheduledFlowOps.insertScheduledFlow(
            started.executionId,
            reviewStepId,
          )
          enqueuedJobs.length = 0

          const abandonResult = yield* abandonExecutionEffect(
            started.executionId,
            "manual cleanup",
            makeContext(seed.rolePath, seed.orgUnitPath),
          )
          const executionQueries = yield* ExecutionQueries
          const executions = yield* executionQueries.getExecutions([
            started.executionId,
          ])
          const scheduledFlowIds = yield* db.getScheduledFlowIdsForExecution(
            started.executionId,
          )

          const execution = executions[0]
          return {
            abandonResult,
            executionStatus: execution?.status,
            abandonedReason: execution?.abandonedReason,
            scheduledFlowIds,
            started,
          }
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              db.layer,
              makeQueueLayer(enqueuedJobs),
              makeAbandonAuthorizationLayer(authorizedStepPaths),
              fileSystemLayer,
            ),
          ),
        ) as unknown as Effect.Effect<AbandonTestResult, unknown, never>,
      )

      expect(result.abandonResult).toEqual({ success: true, error: null })
      expect(authorizedStepPaths).toEqual([seed.reviewStepPath])
      expect(result.executionStatus).toBe("Abandoned")
      expect(result.abandonedReason).toBe("manual cleanup")
      expect(result.scheduledFlowIds).toEqual([])
      expect(enqueuedJobs).toEqual([
        {
          queue: EXECUTION_EVENT_QUEUE,
          payload: {
            executionId: result.started.executionId,
            processId: result.started.processId,
            eventType: "updated",
          },
        },
        {
          queue: PROCESS_EVENT_QUEUE,
          payload: {
            processId: result.started.processId,
            eventType: "updated",
          },
        },
      ])
    })

    it("abandons a running execution with an active todo and soft-deletes remaining work", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const authorizedStepPaths: string[] = []
      const seed = makePendingFlowOrganisation(
        `${db.name}-running-${uniqueSuffix()}`,
      )

      const result = await Effect.runPromise(
        provideAbandonLayers(
          db,
          enqueuedJobs,
          authorizedStepPaths,
          Effect.gen(function* () {
            const activeTodo = yield* seedActiveTodo(db, {
              organisation: seed.org,
              orgUnitPath: seed.orgUnitPath,
              rolePath: seed.rolePath,
              processPath: seed.processPath,
              startStepPath: seed.startStepPath,
              todoStepPath: seed.reviewStepPath,
            })
            enqueuedJobs.length = 0

            const abandonResult = yield* abandonExecutionEffect(
              activeTodo.executionId,
              "stop in-flight work",
              makeContext(seed.rolePath, seed.orgUnitPath),
            )
            const executionQueries = yield* ExecutionQueries
            const executions = yield* executionQueries.getExecutions([
              activeTodo.executionId,
            ])
            const todo = yield* db.getTodoById(activeTodo.todoId)
            const executionStatusRow = yield* db.getProcessExecutionStatus(
              activeTodo.executionId,
            )

            return {
              abandonResult,
              executionStatus: executions[0]?.status,
              abandonedReason: executions[0]?.abandonedReason,
              abandonedAt: executionStatusRow?.abandonedAt ?? null,
              scheduledFlowIds: yield* db.getScheduledFlowIdsForExecution(
                activeTodo.executionId,
              ),
              todoDeleted: todo?.deleted,
              todoFailureReason: todo?.failureReason,
              started: {
                executionId: activeTodo.executionId,
                processId: activeTodo.processId,
              },
              todoId: activeTodo.todoId,
            }
          }),
        ),
      )

      expect(result.abandonResult).toEqual({ success: true, error: null })
      expect(authorizedStepPaths).toEqual([seed.reviewStepPath])
      expect(result.executionStatus).toBe("Abandoned")
      expect(result.abandonedReason).toBe("stop in-flight work")
      expect(result.abandonedAt).not.toBeNull()
      expect(result.todoDeleted).toBe(true)
      expect(result.todoFailureReason).toBe("Execution abandoned")
      expect(enqueuedJobs).toEqual([
        {
          queue: EXECUTION_EVENT_QUEUE,
          payload: {
            executionId: result.started.executionId,
            processId: result.started.processId,
            eventType: "updated",
          },
        },
        {
          queue: TODO_EVENT_QUEUE,
          payload: {
            todoIds: [result.todoId],
          },
        },
        {
          queue: PROCESS_EVENT_QUEUE,
          payload: {
            processId: result.started.processId,
            eventType: "updated",
          },
        },
      ])
    })

    it("abandons a Docker-failed execution whose row is still Running by authorizing against the failed todo", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const authorizedStepPaths: string[] = []
      const seed = makePendingFlowOrganisation(
        `${db.name}-docker-failed-${uniqueSuffix()}`,
      )

      const result = await Effect.runPromise(
        provideAbandonLayers(
          db,
          enqueuedJobs,
          authorizedStepPaths,
          Effect.gen(function* () {
            const activeTodo = yield* seedActiveTodo(db, {
              organisation: seed.org,
              orgUnitPath: seed.orgUnitPath,
              rolePath: seed.rolePath,
              processPath: seed.processPath,
              startStepPath: seed.startStepPath,
              todoStepPath: seed.reviewStepPath,
            })
            const stepCompletionOps = yield* StepCompletionOperations
            yield* stepCompletionOps.failToDo(activeTodo.todoId, "Step failed.")
            enqueuedJobs.length = 0

            const abandonResult = yield* abandonExecutionEffect(
              activeTodo.executionId,
              "dismiss failed deploy",
              makeContext(seed.rolePath, seed.orgUnitPath),
            )
            const executionQueries = yield* ExecutionQueries
            const executions = yield* executionQueries.getExecutions([
              activeTodo.executionId,
            ])
            const executionStatusRow = yield* db.getProcessExecutionStatus(
              activeTodo.executionId,
            )

            return {
              abandonResult,
              executionStatus: executions[0]?.status,
              abandonedReason: executions[0]?.abandonedReason,
              abandonedAt: executionStatusRow?.abandonedAt ?? null,
              scheduledFlowIds: yield* db.getScheduledFlowIdsForExecution(
                activeTodo.executionId,
              ),
              started: {
                executionId: activeTodo.executionId,
                processId: activeTodo.processId,
              },
            }
          }),
        ),
      )

      expect(result.abandonResult).toEqual({ success: true, error: null })
      expect(authorizedStepPaths).toEqual([seed.reviewStepPath])
      expect(result.executionStatus).toBe("Abandoned")
      expect(result.abandonedReason).toBe("dismiss failed deploy")
      expect(result.abandonedAt).not.toBeNull()
    })

    it("abandons a Running Todo-less roleless system-start by authorizing against the start step", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const authorizedStepPaths: string[] = []
      const seed = makePendingFlowOrganisation(
        `${db.name}-running-roleless-${uniqueSuffix()}`,
      )

      const result = await Effect.runPromise(
        provideAbandonLayers(
          db,
          enqueuedJobs,
          authorizedStepPaths,
          Effect.gen(function* () {
            yield* db.storeOrganisation(seed.org)
            yield* db.ensureProviderUser({
              email: "employee@example.com",
              rolePaths: [seed.rolePath],
              orgUnitPath: seed.orgUnitPath,
            })
            const processId = yield* db.getProcessIdByPath(seed.processPath)
            const started = yield* startProcessExecution(
              processId,
              seed.processPath,
              seed.startStepPath,
              {},
              { enqueueStartSystemStep: true },
            )
            enqueuedJobs.length = 0

            const abandonResult = yield* abandonExecutionEffect(
              started.executionId,
              "cancel stuck collection",
              makeContext(seed.rolePath, seed.orgUnitPath),
            )
            const executionQueries = yield* ExecutionQueries
            const executions = yield* executionQueries.getExecutions([
              started.executionId,
            ])
            const executionStatusRow = yield* db.getProcessExecutionStatus(
              started.executionId,
            )

            return {
              abandonResult,
              executionStatus: executions[0]?.status,
              abandonedReason: executions[0]?.abandonedReason,
              abandonedAt: executionStatusRow?.abandonedAt ?? null,
              scheduledFlowIds: yield* db.getScheduledFlowIdsForExecution(
                started.executionId,
              ),
              started,
            }
          }),
        ),
      )

      expect(result.abandonResult).toEqual({ success: true, error: null })
      expect(authorizedStepPaths).toEqual([seed.startStepPath])
      expect(result.executionStatus).toBe("Abandoned")
      expect(result.abandonedReason).toBe("cancel stuck collection")
      expect(result.abandonedAt).not.toBeNull()
      expect(result.scheduledFlowIds).toEqual([])
    })

    it("abandons a Todo-less Failed system-start by authorizing against the start step", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const authorizedStepPaths: string[] = []
      const seed = makePendingFlowOrganisation(
        `${db.name}-failed-${uniqueSuffix()}`,
      )

      const result = await Effect.runPromise(
        provideAbandonLayers(
          db,
          enqueuedJobs,
          authorizedStepPaths,
          Effect.gen(function* () {
            yield* db.storeOrganisation(seed.org)
            yield* db.ensureProviderUser({
              email: "employee@example.com",
              rolePaths: [seed.rolePath],
              orgUnitPath: seed.orgUnitPath,
            })
            const processId = yield* db.getProcessIdByPath(seed.processPath)
            const started = yield* startProcessExecution(
              processId,
              seed.processPath,
              seed.startStepPath,
              {},
              { enqueueStartSystemStep: true },
            )
            const flowExecutionOps = yield* FlowExecutionOperations
            yield* flowExecutionOps.setProcessExecutionFailed(
              started.executionId,
              "collection boom",
            )
            enqueuedJobs.length = 0

            const abandonResult = yield* abandonExecutionEffect(
              started.executionId,
              "dismiss failed collection",
              makeContext(seed.rolePath, seed.orgUnitPath),
            )
            const executionQueries = yield* ExecutionQueries
            const executions = yield* executionQueries.getExecutions([
              started.executionId,
            ])
            const executionStatusRow = yield* db.getProcessExecutionStatus(
              started.executionId,
            )

            return {
              abandonResult,
              executionStatus: executions[0]?.status,
              abandonedReason: executions[0]?.abandonedReason,
              abandonedAt: executionStatusRow?.abandonedAt ?? null,
              scheduledFlowIds: yield* db.getScheduledFlowIdsForExecution(
                started.executionId,
              ),
              started,
            }
          }),
        ),
      )

      expect(result.abandonResult).toEqual({ success: true, error: null })
      expect(authorizedStepPaths).toEqual([seed.startStepPath])
      expect(result.executionStatus).toBe("Abandoned")
      expect(result.abandonedReason).toBe("dismiss failed collection")
      expect(result.abandonedAt).not.toBeNull()
      expect(result.scheduledFlowIds).toEqual([])
    })

    it("preserves Failed diagnostic text when abandoning without a reason", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const authorizedStepPaths: string[] = []
      const seed = makePendingFlowOrganisation(
        `${db.name}-keep-reason-${uniqueSuffix()}`,
      )

      const result = await Effect.runPromise(
        provideAbandonLayers(
          db,
          enqueuedJobs,
          authorizedStepPaths,
          Effect.gen(function* () {
            yield* db.storeOrganisation(seed.org)
            yield* db.ensureProviderUser({
              email: "employee@example.com",
              rolePaths: [seed.rolePath],
              orgUnitPath: seed.orgUnitPath,
            })
            const processId = yield* db.getProcessIdByPath(seed.processPath)
            const started = yield* startProcessExecution(
              processId,
              seed.processPath,
              seed.startStepPath,
              {},
              { enqueueStartSystemStep: true },
            )
            const flowExecutionOps = yield* FlowExecutionOperations
            yield* flowExecutionOps.setProcessExecutionFailed(
              started.executionId,
              "collection boom",
            )
            enqueuedJobs.length = 0

            const abandonResult = yield* abandonExecutionEffect(
              started.executionId,
              undefined,
              makeContext(seed.rolePath, seed.orgUnitPath),
            )
            const executionQueries = yield* ExecutionQueries
            const executions = yield* executionQueries.getExecutions([
              started.executionId,
            ])
            const executionStatusRow = yield* db.getProcessExecutionStatus(
              started.executionId,
            )

            return {
              abandonResult,
              executionStatus: executions[0]?.status,
              abandonedReason: executions[0]?.abandonedReason,
              abandonedAt: executionStatusRow?.abandonedAt ?? null,
              scheduledFlowIds: [],
              started,
            }
          }),
        ),
      )

      expect(result.abandonResult).toEqual({ success: true, error: null })
      expect(result.executionStatus).toBe("Abandoned")
      expect(result.abandonedReason).toBe("collection boom")
      expect(result.abandonedAt).not.toBeNull()
    })

    it("does not abandon a Failed system-start when Cedar denies the start step", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const authorizedStepPaths: string[] = []
      const seed = makePendingFlowOrganisation(
        `${db.name}-denied-${uniqueSuffix()}`,
      )

      const result = await Effect.runPromise(
        provideAbandonLayers(
          db,
          enqueuedJobs,
          authorizedStepPaths,
          Effect.gen(function* () {
            yield* db.storeOrganisation(seed.org)
            yield* db.ensureProviderUser({
              email: "employee@example.com",
              rolePaths: [seed.rolePath],
              orgUnitPath: seed.orgUnitPath,
            })
            const processId = yield* db.getProcessIdByPath(seed.processPath)
            const started = yield* startProcessExecution(
              processId,
              seed.processPath,
              seed.startStepPath,
              {},
              { enqueueStartSystemStep: true },
            )
            const flowExecutionOps = yield* FlowExecutionOperations
            yield* flowExecutionOps.setProcessExecutionFailed(
              started.executionId,
              "collection boom",
            )
            enqueuedJobs.length = 0

            const abandonResult = yield* abandonExecutionEffect(
              started.executionId,
              "dismiss failed collection",
              makeContext(seed.rolePath, seed.orgUnitPath),
            )
            const executionQueries = yield* ExecutionQueries
            const executions = yield* executionQueries.getExecutions([
              started.executionId,
            ])
            const executionStatusRow = yield* db.getProcessExecutionStatus(
              started.executionId,
            )

            return {
              abandonResult,
              executionStatus: executions[0]?.status,
              abandonedReason: executions[0]?.abandonedReason,
              abandonedAt: executionStatusRow?.abandonedAt ?? null,
              scheduledFlowIds: [],
              started,
            }
          }),
          false,
        ),
      )

      expect(result.abandonResult).toEqual({
        success: false,
        error: "Not authorized to abandon this execution",
      })
      expect(authorizedStepPaths).toEqual([seed.startStepPath])
      expect(result.executionStatus).toBe("Failed")
      expect(result.abandonedReason).toBe("collection boom")
      expect(result.abandonedAt).toBeNull()
    })

    it("rejects abandoning Completed and already-Abandoned executions", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const authorizedStepPaths: string[] = []
      const seed = makePendingFlowOrganisation(
        `${db.name}-terminal-${uniqueSuffix()}`,
      )

      const result = await Effect.runPromise(
        provideAbandonLayers(
          db,
          enqueuedJobs,
          authorizedStepPaths,
          Effect.gen(function* () {
            yield* db.storeOrganisation(seed.org)
            yield* db.ensureProviderUser({
              email: "employee@example.com",
              rolePaths: [seed.rolePath],
              orgUnitPath: seed.orgUnitPath,
            })
            const processId = yield* db.getProcessIdByPath(seed.processPath)
            const completed = yield* startProcessExecution(
              processId,
              seed.processPath,
              seed.startStepPath,
              {},
              { enqueueStartSystemStep: true },
            )
            const flowExecutionOps = yield* FlowExecutionOperations
            yield* flowExecutionOps.setProcessExecutionFinished(
              completed.executionId,
              null,
            )
            const completedAbandon = yield* abandonExecutionEffect(
              completed.executionId,
              "too late",
              makeContext(seed.rolePath, seed.orgUnitPath),
            )

            const failed = yield* startProcessExecution(
              processId,
              seed.processPath,
              seed.startStepPath,
              { second: true },
              { enqueueStartSystemStep: true },
            )
            yield* flowExecutionOps.setProcessExecutionFailed(
              failed.executionId,
              "collection boom",
            )
            const firstAbandon = yield* abandonExecutionEffect(
              failed.executionId,
              "dismiss once",
              makeContext(seed.rolePath, seed.orgUnitPath),
            )
            const secondAbandon = yield* abandonExecutionEffect(
              failed.executionId,
              "dismiss again",
              makeContext(seed.rolePath, seed.orgUnitPath),
            )

            return {
              completedAbandon,
              firstAbandon,
              secondAbandon,
              authorizedStepPaths,
            }
          }),
        ),
      )

      expect(result.completedAbandon).toEqual({
        success: false,
        error: "Only running or failed executions can be abandoned",
      })
      expect(result.firstAbandon).toEqual({ success: true, error: null })
      expect(result.secondAbandon).toEqual({
        success: false,
        error: "Only running or failed executions can be abandoned",
      })
    })
  })
}

runSuite(sqliteDbCase)
if (runPostgresDbSpecs) {
  runSuite(postgresDbCase)
}
