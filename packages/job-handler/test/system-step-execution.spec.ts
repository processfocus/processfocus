import { SqlClient } from "@effect/sql"
import { and, eq, sql } from "drizzle-orm"
import {
  DateTime,
  Duration,
  Schema as ES,
  Effect,
  type Effect as EffectType,
  Exit,
  FiberRef,
  Layer,
  Option,
} from "effect"
import * as schema from "@pf/drizzle-sqlite"
import {
  BusinessCalendarQueries,
  CompletedJobOperations,
  FLOW_EXECUTION_QUEUE,
  FlowExecutionOperations,
  NOTIFICATION_DELIVERY_QUEUE,
  SYSTEM_STEP_EXECUTION_QUEUE,
  ScheduledFlowOperations,
  StepCompletionOperations,
  TODO_EVENT_QUEUE,
  UserDetails,
  type UserDetailsValue,
  serializeNotificationPreferences,
} from "@pf/graphql-db-operations"
import {
  EXECUTION_EVENT_QUEUE,
  type NotificationDeliveryPayload,
  PROCESS_EVENT_QUEUE,
  completeAsyncSystemStep,
  failAsyncSystemStep,
  failTerminalSystemStep,
  flowExecutionHandler,
  systemStepExecutionHandler,
} from "@pf/job-handler"
import { storeOrganisation } from "@pf/org-to-db"
import {
  type AuthorTaggedError,
  ConditionEvaluator,
  ExecutionFailureNotifications,
  Form,
  NodeStep,
  Organisation,
  OrganisationProviderTest,
  Process,
  Role,
  ScheduleEvaluator,
  SystemStep,
  SystemStepExecutor,
  makeConditionEvaluator,
  makeScheduleEvaluator,
  makeSystemStepExecutor,
  normalizePath,
} from "@pf/process"
import type { Job } from "@pf/queue-service"
import { EnqueueError, QueueService } from "@pf/queue-service"
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
import { describe, expect, it } from "bun:test"

interface EnqueuedJob {
  queue: string
  payload: unknown
  logicalJobId?: string
}

class SchoolGoogleCalendarConfigurationError extends Error {
  readonly _tag = "SchoolGoogleCalendarConfigurationError"
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

const makeTestOrg = (
  executeEffect: EffectType.Effect<
    Record<string, unknown>,
    AuthorTaggedError,
    unknown
  >,
) => {
  const org = new Organisation({ name: "TestOrg" })
  const employee = new Role(org, "employee", { name: "Employee" })
  const process = new Process(org, "system-step-process", {
    name: "System Step Process",
    purpose: "Test process for system-step-execution handler",
  })

  const submit = new Form(process, "submit", {
    name: "Submit",
    role: employee,
    purpose: "Submit step",
    form: () => ({}),
  })

  const system = new NodeStep(process, "system", {
    name: "System",
    purpose: "System step",
    input: () => Effect.succeed({}),
    output: {},
    execute: () => executeEffect,
  })

  process.start(submit).next(system).end()

  return { org, system }
}

const makeOnErrorTestOrg = (
  executeEffect: EffectType.Effect<
    Record<string, unknown>,
    AuthorTaggedError,
    unknown
  >,
) => {
  const org = new Organisation({ name: "OnErrorTestOrg" })
  const employee = new Role(org, "employee", { name: "Employee" })
  const process = new Process(org, "system-step-process", {
    name: "System Step Process",
    purpose: "Test process for onError routing",
  })

  const submit = new Form(process, "submit", {
    role: employee,
    form: () => ({}),
  })
  const system = new NodeStep(process, "system", {
    input: () => Effect.succeed({}),
    output: {},
    execute: () => executeEffect,
  })
  const recover = new Form(process, "recover", {
    role: employee,
    form: () => ({}),
  })

  process.start(submit).next(system)
  system.onError(recover, { taggedErrors: ["Retryable"] }).end()

  return { org, system }
}

const makeCatchAllOnErrorTestOrg = (
  executeEffect: EffectType.Effect<
    Record<string, unknown>,
    AuthorTaggedError,
    unknown
  >,
) => {
  const org = new Organisation({ name: "CatchAllOnErrorTestOrg" })
  const employee = new Role(org, "employee", { name: "Employee" })
  const process = new Process(org, "system-step-process", {
    name: "System Step Process",
    purpose: "Test process for catch-all onError routing",
  })

  const submit = new Form(process, "submit", {
    role: employee,
    form: () => ({}),
  })
  const system = new NodeStep(process, "system", {
    input: () => Effect.succeed({}),
    output: {},
    execute: () => executeEffect,
  })
  const recover = new Form(process, "recover", {
    role: employee,
    form: () => ({}),
  })

  process.start(submit).next(system)
  system.onError(recover).end()

  return {
    org,
    paths: {
      recover: normalizePath(recover.node.path),
      system: normalizePath(system.node.path),
    },
  }
}

const makeOutermostTaggedOnErrorTestOrg = (
  executeEffect: EffectType.Effect<
    Record<string, unknown>,
    AuthorTaggedError,
    unknown
  >,
) => {
  const org = new Organisation({ name: "OutermostTaggedOnErrorTestOrg" })
  const employee = new Role(org, "employee", { name: "Employee" })
  const process = new Process(org, "system-step-process", {
    name: "System Step Process",
    purpose: "Test process for outermost tagged onError routing",
  })

  const submit = new Form(process, "submit", {
    role: employee,
    form: () => ({}),
  })
  const system = new NodeStep(process, "system", {
    input: () => Effect.succeed({}),
    output: {},
    execute: () => executeEffect,
  })
  const outerRecover = new Form(process, "outer_recover", {
    role: employee,
    form: () => ({}),
  })
  const innerRecover = new Form(process, "inner_recover", {
    role: employee,
    form: () => ({}),
  })
  const catchAllRecover = new Form(process, "catch_all_recover", {
    role: employee,
    form: () => ({}),
  })

  process.start(submit).next(system)
  system.onError(outerRecover, { taggedErrors: ["Retryable"] }).end()
  system.onError(innerRecover, { taggedErrors: ["Inner"] }).end()
  system.onError(catchAllRecover).end()

  return {
    org,
    paths: {
      outerRecover: normalizePath(outerRecover.node.path),
      innerRecover: normalizePath(innerRecover.node.path),
      catchAllRecover: normalizePath(catchAllRecover.node.path),
      system: normalizePath(system.node.path),
    },
  }
}

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
    mockQueueServiceLayer,
    OperationLayers,
    BaseDbLayer,
  )

  return { layers, enqueuedJobs }
}

const insertExecutionWithSystemTodo = Effect.gen(function* () {
  const db = yield* TypedSqliteDrizzle

  const steps = yield* db.select().from(schema.step)
  const systemStep = steps.find((s) => s.roleId == null)
  if (!systemStep) throw new Error("System step not found")

  const flows = yield* db.select().from(schema.flow)
  const flowToSystem = flows.find((f) => f.targetStepId === systemStep.id)
  if (!flowToSystem) throw new Error("Flow to system step not found")

  const processes = yield* db.select().from(schema.process)
  const process = processes[0]
  if (!process) throw new Error("Process not found")

  const processStateId = "pst-test-system-001"
  yield* db.insert(schema.processState).values({
    id: processStateId,
    processId: process.id,
    startStepId: flowToSystem.sourceStepId,
    state: {},
  })

  const processExecutionId = "pex-test-system-001"
  yield* db.insert(schema.processExecution).values({
    id: processExecutionId,
    processStateId,
  })

  const todoId = "todo-test-system-001"
  yield* db.insert(schema.toDo).values({
    id: todoId,
    processExecutionId,
    flowId: flowToSystem.id,
  })

  return {
    todoId,
    stepPath: systemStep.path,
    processExecutionId,
  }
})

const makeForEachSystemStepOrg = (
  execute: (input: {
    recipient: string
  }) => EffectType.Effect<{ recipient: string }, AuthorTaggedError, unknown> = (
    input,
  ) => Effect.succeed(input),
) => {
  const org = new Organisation({ name: "TestOrg" })
  const employee = new Role(org, "employee", { name: "Employee" })
  const process = new Process(org, "for-each-system-step-process", {
    name: "ForEach System Step Process",
    purpose: "Test process for async forEach completion",
  })

  const submit = new Form(process, "submit", {
    name: "Submit",
    role: employee,
    purpose: "Submit step",
    form: () => ({}),
  })

  const sendBatch = new NodeStep(process, "sendBatch", {
    name: "Send batch",
    purpose: "ForEach system step",
    forEach: {
      items: () =>
        Effect.succeed([{ recipient: "first" }, { recipient: "second" }]),
    },
    output: { recipient: ES.String },
    execute,
  })

  process.start(submit).next(sendBatch).end()

  return { org, sendBatch }
}

const insertExecutionWithForEachSystemTodos = Effect.gen(function* () {
  const db = yield* TypedSqliteDrizzle

  const steps = yield* db.select().from(schema.step)
  const forEachStep = steps.find((step) => step.path.endsWith("/sendBatch"))
  if (!forEachStep) throw new Error("ForEach system step not found")

  const flows = yield* db.select().from(schema.flow)
  const flowToForEach = flows.find((f) => f.targetStepId === forEachStep.id)
  if (!flowToForEach) throw new Error("Flow to forEach system step not found")

  const processes = yield* db.select().from(schema.process)
  const process = processes[0]
  if (!process) throw new Error("Process not found")

  const processStateId = "pst-test-foreach-001"
  yield* db.insert(schema.processState).values({
    id: processStateId,
    processId: process.id,
    startStepId: flowToForEach.sourceStepId,
    state: {},
  })

  const processExecutionId = "pex-test-foreach-001"
  yield* db.insert(schema.processExecution).values({
    id: processExecutionId,
    processStateId,
  })

  const barrierRows = yield* db
    .insert(schema.scheduledFlow)
    .values({
      processExecutionId,
      sourceStepId: forEachStep.id,
      forEachBarrier: true,
    })
    .returning({ id: schema.scheduledFlow.id })

  const barrierScheduledFlowId = barrierRows[0]?.id
  if (!barrierScheduledFlowId) {
    throw new Error("ForEach barrier scheduled flow not created")
  }

  yield* db.insert(schema.toDo).values([
    {
      id: "todo-test-foreach-001",
      processExecutionId,
      flowId: flowToForEach.id,
      itemData: { recipient: "first" },
      barrierScheduledFlowId,
    },
    {
      id: "todo-test-foreach-002",
      processExecutionId,
      flowId: flowToForEach.id,
      itemData: { recipient: "second" },
      barrierScheduledFlowId,
    },
  ])

  return {
    todoIds: ["todo-test-foreach-001", "todo-test-foreach-002"] as const,
    stepPath: forEachStep.path,
    processStateId,
    processExecutionId,
  }
})

const makeStartSystemStepOrg = (
  executeEffect: EffectType.Effect<
    { greeting: string },
    AuthorTaggedError,
    unknown
  >,
) => {
  const org = new Organisation({ name: "TestOrg" })
  const process = new Process(org, "start-system-step-process", {
    name: "Start System Step Process",
    purpose: "Test process for system-start execution",
  })

  const hello = new NodeStep(process, "hello", {
    name: "Hello",
    purpose: "Start system step",
    input: () => Effect.succeed({}),
    output: { greeting: ES.String },
    execute: () => executeEffect,
  })

  process.start(hello).end()

  return { org, hello }
}

const insertExecutionForStartSystemStep = Effect.gen(function* () {
  const db = yield* TypedSqliteDrizzle

  const steps = yield* db.select().from(schema.step)
  const startStep = steps.find((step) => step.path.endsWith("/hello"))
  if (!startStep) throw new Error("Start system step not found")

  const processes = yield* db.select().from(schema.process)
  const process = processes[0]
  if (!process) throw new Error("Process not found")

  const processStateId = "pst-test-start-system-001"
  yield* db.insert(schema.processState).values({
    id: processStateId,
    processId: process.id,
    startStepId: startStep.id,
    state: {},
  })

  const processExecutionId = "pex-test-start-system-001"
  yield* db.insert(schema.processExecution).values({
    id: processExecutionId,
    processStateId,
  })

  return {
    processExecutionId,
    stepId: startStep.id,
    stepPath: startStep.path,
  }
})

const loadTodoInfo = (todoId: string) =>
  Effect.gen(function* () {
    const stepCompletionOps = yield* StepCompletionOperations

    const todoInfo = yield* stepCompletionOps.queryTodoById(todoId)
    if (!todoInfo) {
      throw new Error(`Todo ${todoId} not found`)
    }

    return todoInfo
  })

const queryExecutionFailure = (processExecutionId: string) =>
  Effect.gen(function* () {
    const db = yield* TypedSqliteDrizzle
    const rows = yield* db
      .select({
        finishedAt: schema.processExecution.finishedAt,
        abandonedAt: schema.processExecution.abandonedAt,
        abandonedReason: schema.processExecution.abandonedReason,
      })
      .from(schema.processExecution)
      .where(eq(schema.processExecution.id, processExecutionId))
      .limit(1)

    return rows[0]
  })

const getNotificationJobs = (
  enqueuedJobs: readonly EnqueuedJob[],
): Array<{
  queue: string
  payload: NotificationDeliveryPayload
}> =>
  enqueuedJobs
    .filter((job) => job.queue === NOTIFICATION_DELIVERY_QUEUE)
    .map((job) => ({
      queue: job.queue,
      payload: job.payload as NotificationDeliveryPayload,
    }))

const insertProviderUser = (params: {
  userId: string
  providerUserId: string
  roleIds: readonly string[]
  email: string
  name: string
  executionFailureEmailEnabled: boolean
}) =>
  Effect.gen(function* () {
    const db = yield* TypedSqliteDrizzle
    const now = yield* DateTime.now
    const orgUnits = yield* db.select().from(schema.orgUnit)
    const orgUnit = orgUnits[0]
    if (!orgUnit) {
      throw new Error("Org unit not found")
    }

    yield* db.insert(schema.user).values({
      id: params.userId,
      provider: "test",
      sub: params.email,
      lastLoggedIn: now,
    })

    const [firstName, ...rest] = params.name.split(" ")
    yield* db.insert(schema.providerUser).values({
      id: params.providerUserId,
      userId: params.userId,
      email: params.email,
      name: params.name,
      firstName: firstName ?? params.name,
      lastName: rest.join(" "),
      picture: "",
      locale: "en",
      orgUnitId: orgUnit.id,
    })

    if (params.roleIds.length > 0) {
      yield* db.insert(schema.providerUserRole).values(
        params.roleIds.map((roleId, index) => ({
          id: `pur-${params.providerUserId}-${index}`,
          providerUserId: params.providerUserId,
          roleId,
        })),
      )
    }

    yield* db.insert(schema.userSettings).values({
      id: `us-${params.userId}`,
      userId: params.userId,
      notificationPreference: serializeNotificationPreferences({
        notifications: {
          todoAssignment: {
            email: false,
          },
          executionFailure: {
            email: params.executionFailureEmailEnabled,
          },
        },
      }),
    })
  })

const getRoleIdsByPath = (rolePaths: readonly string[]) =>
  Effect.gen(function* () {
    const db = yield* TypedSqliteDrizzle
    const roles = yield* db.select().from(schema.role)

    return rolePaths.map((rolePath) => {
      const role = roles.find((candidate) => candidate.path === rolePath)
      if (!role) {
        throw new Error(`Role ${rolePath} not found`)
      }

      return role.id
    })
  })

const makeExecutionFailureNotificationsOrg = (props?: {
  notificationRoles?: (roles: {
    employee: Role
    operator: Role
    backup: Role
  }) => readonly Role[] | undefined
  executeEffect?: EffectType.Effect<
    Record<string, unknown>,
    AuthorTaggedError,
    unknown
  >
}) => {
  const org = new Organisation({ name: "TestOrg" })
  const employee = new Role(org, "employee", { name: "Employee" })
  const operator = new Role(org, "operator", { name: "Operator" })
  const backup = new Role(org, "backup", { name: "Backup" })

  const notificationRoles = props?.notificationRoles?.({
    employee,
    operator,
    backup,
  })
  if (notificationRoles !== undefined) {
    new ExecutionFailureNotifications(org, { roles: notificationRoles })
  }

  const process = new Process(org, "system-step-process", {
    name: "System Step Process",
    purpose: "Test process for system-step-execution handler",
  })

  const submit = new Form(process, "submit", {
    name: "Submit",
    role: employee,
    purpose: "Submit step",
    form: () => ({}),
  })

  const system = new NodeStep(process, "system", {
    name: "System",
    purpose: "System step",
    input: () => Effect.succeed({}),
    output: {},
    execute: () =>
      props?.executeEffect ??
      Effect.fail({ _tag: "TestFailure", message: "boom" }),
  })

  process.start(submit).next(system).end()

  return { org, operator, backup }
}

describe("System Step Execution Handler", () => {
  it("records failure on last attempt", async () => {
    const { org } = makeTestOrg(
      Effect.fail({ _tag: "TestFailure", message: "boom" }),
    )
    const { layers: TestLayers, enqueuedJobs } = createTestLayers(org)

    const program = Effect.gen(function* () {
      yield* storeOrganisation(org)
      const { todoId, stepPath, processExecutionId } =
        yield* insertExecutionWithSystemTodo

      const now = yield* DateTime.now
      const job: Job<{ todoId: string; stepPath: string }> = {
        jobId: "job-test-system-001",
        queue: SYSTEM_STEP_EXECUTION_QUEUE,
        payload: { todoId, stepPath },
        attempts: 5,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      }

      yield* systemStepExecutionHandler.handle(job)

      const db = yield* TypedSqliteDrizzle
      const rows = yield* db
        .select({
          deleted: schema.toDo._deleted,
          failureReason: schema.toDo.failureReason,
        })
        .from(schema.toDo)
        .where(and(eq(schema.toDo.id, todoId), eq(schema.toDo._deleted, false)))
        .limit(1)

      expect(rows[0]?.deleted).toBe(false)
      expect(rows[0]?.failureReason).toContain("boom")

      const execution = yield* queryExecutionFailure(processExecutionId)
      expect(execution?.finishedAt).not.toBeNull()
      expect(execution?.abandonedAt).toBeNull()
      expect(execution?.abandonedReason).toContain("boom")

      const completedJobOps = yield* CompletedJobOperations
      const isCompleted = yield* completedJobOps.isJobCompleted(
        SYSTEM_STEP_EXECUTION_QUEUE,
        job.jobId,
      )
      expect(isCompleted).toBe(true)

      expect(enqueuedJobs.map((j) => j.queue)).toContain(TODO_EVENT_QUEUE)
      expect(enqueuedJobs.map((j) => j.queue)).not.toContain(
        FLOW_EXECUTION_QUEUE,
      )
    })

    await Effect.runPromise(
      Effect.provide(program, TestLayers) as Effect.Effect<void>,
    )
  })

  it("enqueues onError flow execution on terminal failure", async () => {
    const { org } = makeOnErrorTestOrg(
      Effect.fail({ _tag: "Retryable", message: "boom" }),
    )
    const { layers: TestLayers, enqueuedJobs } = createTestLayers(org)

    const program = Effect.gen(function* () {
      yield* storeOrganisation(org)
      const { todoId, stepPath, processExecutionId } =
        yield* insertExecutionWithSystemTodo

      const now = yield* DateTime.now
      const job: Job<{ todoId: string; stepPath: string }> = {
        jobId: "job-test-system-onerror-001",
        queue: SYSTEM_STEP_EXECUTION_QUEUE,
        payload: { todoId, stepPath },
        attempts: 5,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      }

      yield* systemStepExecutionHandler.handle(job)

      const flowExecutionJob = enqueuedJobs.find(
        (queuedJob) => queuedJob.queue === FLOW_EXECUTION_QUEUE,
      )
      expect(flowExecutionJob).toBeDefined()
      expect(flowExecutionJob?.payload).toMatchObject({
        onError: true,
        errorTag: "Retryable",
      })

      const execution = yield* queryExecutionFailure(processExecutionId)
      expect(execution?.finishedAt).toBeNull()
      expect(execution?.abandonedReason).toBeNull()
    })

    await Effect.runPromise(
      Effect.provide(program, TestLayers) as Effect.Effect<void>,
    )
  })

  it("enqueues onError flow execution for tagged defects", async () => {
    const { org } = makeOnErrorTestOrg(
      Effect.die({ _tag: "Retryable", message: "boom" }),
    )
    const { layers: TestLayers, enqueuedJobs } = createTestLayers(org)

    const program = Effect.gen(function* () {
      yield* storeOrganisation(org)
      const { todoId, stepPath, processExecutionId } =
        yield* insertExecutionWithSystemTodo

      const now = yield* DateTime.now
      const job: Job<{ todoId: string; stepPath: string }> = {
        jobId: "job-test-system-onerror-defect-001",
        queue: SYSTEM_STEP_EXECUTION_QUEUE,
        payload: { todoId, stepPath },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      }

      yield* systemStepExecutionHandler.handle(job)

      const flowExecutionJob = enqueuedJobs.find(
        (queuedJob) => queuedJob.queue === FLOW_EXECUTION_QUEUE,
      )
      expect(flowExecutionJob).toBeDefined()
      expect(flowExecutionJob?.payload).toMatchObject({
        onError: true,
        errorTag: "Retryable",
      })

      const execution = yield* queryExecutionFailure(processExecutionId)
      expect(execution?.finishedAt).toBeNull()
      expect(execution?.abandonedReason).toBeNull()
    })

    await Effect.runPromise(
      Effect.provide(program, TestLayers) as Effect.Effect<void>,
    )
  })

  it("does not enqueue onError flow execution when no error branch matches", async () => {
    const { org } = makeOnErrorTestOrg(
      Effect.fail({ _tag: "TestFailure", message: "boom" }),
    )
    const { layers: TestLayers, enqueuedJobs } = createTestLayers(org)

    const program = Effect.gen(function* () {
      yield* storeOrganisation(org)
      const { todoId, stepPath, processExecutionId } =
        yield* insertExecutionWithSystemTodo

      const now = yield* DateTime.now
      const job: Job<{ todoId: string; stepPath: string }> = {
        jobId: "job-test-system-onerror-no-match-001",
        queue: SYSTEM_STEP_EXECUTION_QUEUE,
        payload: { todoId, stepPath },
        attempts: 5,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      }

      yield* systemStepExecutionHandler.handle(job)

      expect(enqueuedJobs.map((queuedJob) => queuedJob.queue)).not.toContain(
        FLOW_EXECUTION_QUEUE,
      )

      const execution = yield* queryExecutionFailure(processExecutionId)
      expect(execution?.finishedAt).not.toBeNull()
      expect(execution?.abandonedAt).toBeNull()
      expect(execution?.abandonedReason).toContain("boom")
    })

    await Effect.runPromise(
      Effect.provide(program, TestLayers) as Effect.Effect<void>,
    )
  })

  it("creates catch-all recovery todos through the normal flow pipeline", async () => {
    const { org, paths } = makeCatchAllOnErrorTestOrg(
      Effect.fail({ _tag: "TestFailure", message: "boom" }),
    )
    const { layers: TestLayers, enqueuedJobs } = createTestLayers(org)

    const program = Effect.gen(function* () {
      yield* storeOrganisation(org)
      const { todoId, stepPath, processExecutionId } =
        yield* insertExecutionWithSystemTodo

      const now = yield* DateTime.now
      const systemJob: Job<{ todoId: string; stepPath: string }> = {
        jobId: "job-test-system-onerror-catch-all-001",
        queue: SYSTEM_STEP_EXECUTION_QUEUE,
        payload: { todoId, stepPath },
        attempts: 5,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      }

      yield* systemStepExecutionHandler.handle(systemJob)

      const flowPayload = enqueuedJobs.find(
        (queuedJob) => queuedJob.queue === FLOW_EXECUTION_QUEUE,
      )?.payload as { scheduledFlowId: string; onError?: boolean } | undefined

      expect(flowPayload).toBeDefined()
      expect(flowPayload).toMatchObject({ onError: true })

      const flowJob: Job<{ scheduledFlowId: string; onError?: boolean }> = {
        jobId: "job-test-flow-onerror-catch-all-001",
        queue: FLOW_EXECUTION_QUEUE,
        payload: flowPayload!,
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      }

      yield* flowExecutionHandler.handle(flowJob)

      const db = yield* TypedSqliteDrizzle
      const originalTodo = yield* db
        .select({
          deleted: schema.toDo._deleted,
          failureReason: schema.toDo.failureReason,
        })
        .from(schema.toDo)
        .where(eq(schema.toDo.id, todoId))
        .limit(1)

      expect(originalTodo[0]?.deleted).toBe(false)
      expect(originalTodo[0]?.failureReason).toContain("boom")

      const todoTargets = yield* db
        .select({
          todoId: schema.toDo.id,
          targetPath: schema.step.path,
          failureReason: schema.toDo.failureReason,
        })
        .from(schema.toDo)
        .innerJoin(schema.flow, eq(schema.toDo.flowId, schema.flow.id))
        .innerJoin(schema.step, eq(schema.flow.targetStepId, schema.step.id))

      expect(todoTargets).toEqual(
        expect.arrayContaining([
          {
            todoId,
            targetPath: paths.system,
            failureReason: expect.stringContaining("boom"),
          },
          {
            todoId: expect.any(String),
            targetPath: paths.recover,
            failureReason: null,
          },
        ]),
      )
      expect(todoTargets).toHaveLength(2)

      const execution = yield* queryExecutionFailure(processExecutionId)
      expect(execution?.finishedAt).toBeNull()
      expect(execution?.abandonedReason).toBeNull()

      expect(
        enqueuedJobs.filter(
          (queuedJob) => queuedJob.queue === TODO_EVENT_QUEUE,
        ),
      ).toHaveLength(2)
    })

    await Effect.runPromise(
      Effect.provide(program, TestLayers) as Effect.Effect<void>,
    )
  })

  it("routes tagged failures using the outermost exposed error tag", async () => {
    const { org, paths } = makeOutermostTaggedOnErrorTestOrg(
      Effect.fail({
        _tag: "Retryable",
        message: "boom",
        error: { _tag: "Inner", message: "nested" },
      }),
    )
    const { layers: TestLayers, enqueuedJobs } = createTestLayers(org)

    const program = Effect.gen(function* () {
      yield* storeOrganisation(org)
      const { todoId, stepPath } = yield* insertExecutionWithSystemTodo

      const now = yield* DateTime.now
      const systemJob: Job<{ todoId: string; stepPath: string }> = {
        jobId: "job-test-system-onerror-outermost-001",
        queue: SYSTEM_STEP_EXECUTION_QUEUE,
        payload: { todoId, stepPath },
        attempts: 5,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      }

      yield* systemStepExecutionHandler.handle(systemJob)

      const flowPayload = enqueuedJobs.find(
        (queuedJob) => queuedJob.queue === FLOW_EXECUTION_QUEUE,
      )?.payload as
        | { scheduledFlowId: string; onError?: boolean; errorTag?: string }
        | undefined

      expect(flowPayload).toBeDefined()
      expect(flowPayload).toMatchObject({
        onError: true,
        errorTag: "Retryable",
      })

      const flowJob: Job<{
        scheduledFlowId: string
        onError?: boolean
        errorTag?: string
      }> = {
        jobId: "job-test-flow-onerror-outermost-001",
        queue: FLOW_EXECUTION_QUEUE,
        payload: flowPayload!,
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      }

      yield* flowExecutionHandler.handle(flowJob)

      const db = yield* TypedSqliteDrizzle
      const todoTargets = yield* db
        .select({ targetPath: schema.step.path })
        .from(schema.toDo)
        .innerJoin(schema.flow, eq(schema.toDo.flowId, schema.flow.id))
        .innerJoin(schema.step, eq(schema.flow.targetStepId, schema.step.id))

      expect(todoTargets).toEqual(
        expect.arrayContaining([
          { targetPath: paths.system },
          { targetPath: paths.outerRecover },
        ]),
      )
      expect(todoTargets).not.toContainEqual({ targetPath: paths.innerRecover })
      expect(todoTargets).not.toContainEqual({
        targetPath: paths.catchAllRecover,
      })
      expect(todoTargets).toHaveLength(2)
    })

    await Effect.runPromise(
      Effect.provide(program, TestLayers) as Effect.Effect<void>,
    )
  })

  it("records failure immediately for defects", async () => {
    const { org } = makeTestOrg(Effect.die(new Error("defect")))
    const { layers: TestLayers, enqueuedJobs } = createTestLayers(org)

    const program = Effect.gen(function* () {
      yield* storeOrganisation(org)
      const { todoId, stepPath } = yield* insertExecutionWithSystemTodo

      const now = yield* DateTime.now
      const job: Job<{ todoId: string; stepPath: string }> = {
        jobId: "job-test-system-002",
        queue: SYSTEM_STEP_EXECUTION_QUEUE,
        payload: { todoId, stepPath },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      }

      yield* systemStepExecutionHandler.handle(job)

      const db = yield* TypedSqliteDrizzle
      const rows = yield* db
        .select({ failureReason: schema.toDo.failureReason })
        .from(schema.toDo)
        .where(eq(schema.toDo.id, todoId))
        .limit(1)

      expect(rows[0]?.failureReason).toContain("defect")
      expect(getNotificationJobs(enqueuedJobs)).toHaveLength(0)
    })

    await Effect.runPromise(
      Effect.provide(program, TestLayers) as Effect.Effect<void>,
    )
  })

  it("records failure immediately for plugin configuration defects", async () => {
    const { org } = makeTestOrg(
      Effect.die(
        new SchoolGoogleCalendarConfigurationError(
          "Missing SCHOOL_SERVICE_ACCOUNT_KEY",
        ),
      ),
    )
    const { layers: TestLayers, enqueuedJobs } = createTestLayers(org)

    const program = Effect.gen(function* () {
      yield* storeOrganisation(org)
      const { todoId, stepPath } = yield* insertExecutionWithSystemTodo

      const now = yield* DateTime.now
      const job: Job<{ todoId: string; stepPath: string }> = {
        jobId: "job-test-system-nonretryable-001",
        queue: SYSTEM_STEP_EXECUTION_QUEUE,
        payload: { todoId, stepPath },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      }

      yield* systemStepExecutionHandler.handle(job)

      const db = yield* TypedSqliteDrizzle
      const rows = yield* db
        .select({ failureReason: schema.toDo.failureReason })
        .from(schema.toDo)
        .where(eq(schema.toDo.id, todoId))
        .limit(1)

      expect(rows[0]?.failureReason).toContain(
        "Missing SCHOOL_SERVICE_ACCOUNT_KEY",
      )

      const completedJobOps = yield* CompletedJobOperations
      const isCompleted = yield* completedJobOps.isJobCompleted(
        SYSTEM_STEP_EXECUTION_QUEUE,
        job.jobId,
      )
      expect(isCompleted).toBe(true)
      expect(getNotificationJobs(enqueuedJobs)).toHaveLength(0)
    })

    await Effect.runPromise(
      Effect.provide(program, TestLayers) as Effect.Effect<void>,
    )
  })

  it("records failure immediately for tagged errors with retryable: false", async () => {
    const { org } = makeTestOrg(
      Effect.fail({
        _tag: "UnsupportedEngineError",
        message:
          "The MVCC engine used by active database pf-dev is unsupported for Database Upload",
        retryable: false,
      }),
    )
    const { layers: TestLayers, enqueuedJobs } = createTestLayers(org)

    const program = Effect.gen(function* () {
      yield* storeOrganisation(org)
      const { todoId, stepPath, processExecutionId } =
        yield* insertExecutionWithSystemTodo

      const now = yield* DateTime.now
      const job: Job<{ todoId: string; stepPath: string }> = {
        jobId: "job-test-system-nonretryable-guard-001",
        queue: SYSTEM_STEP_EXECUTION_QUEUE,
        payload: { todoId, stepPath },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      }

      yield* systemStepExecutionHandler.handle(job)

      const db = yield* TypedSqliteDrizzle
      const rows = yield* db
        .select({
          deleted: schema.toDo._deleted,
          failureReason: schema.toDo.failureReason,
        })
        .from(schema.toDo)
        .where(eq(schema.toDo.id, todoId))
        .limit(1)

      expect(rows[0]?.deleted).toBe(false)
      expect(rows[0]?.failureReason).toContain(
        "unsupported for Database Upload",
      )

      const execution = yield* queryExecutionFailure(processExecutionId)
      expect(execution?.finishedAt).not.toBeNull()
      expect(execution?.abandonedAt).toBeNull()
      expect(execution?.abandonedReason).toContain(
        "unsupported for Database Upload",
      )

      const completedJobOps = yield* CompletedJobOperations
      const isCompleted = yield* completedJobOps.isJobCompleted(
        SYSTEM_STEP_EXECUTION_QUEUE,
        job.jobId,
      )
      expect(isCompleted).toBe(true)
      expect(getNotificationJobs(enqueuedJobs)).toHaveLength(0)
    })

    await Effect.runPromise(
      Effect.provide(program, TestLayers) as Effect.Effect<void>,
    )
  })

  it("re-raises errors when retries remain", async () => {
    const { org } = makeTestOrg(
      Effect.fail({ _tag: "TestFailure", message: "retry" }),
    )
    const { layers: TestLayers, enqueuedJobs } = createTestLayers(org)

    const program = Effect.gen(function* () {
      yield* storeOrganisation(org)
      const { todoId, stepPath, processExecutionId } =
        yield* insertExecutionWithSystemTodo

      const now = yield* DateTime.now
      const job: Job<{ todoId: string; stepPath: string }> = {
        jobId: "job-test-system-003",
        queue: SYSTEM_STEP_EXECUTION_QUEUE,
        payload: { todoId, stepPath },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      }

      const exit = yield* Effect.exit(systemStepExecutionHandler.handle(job))
      expect(Exit.isFailure(exit)).toBe(true)

      const db = yield* TypedSqliteDrizzle
      const rows = yield* db
        .select({
          deleted: schema.toDo._deleted,
          failureReason: schema.toDo.failureReason,
        })
        .from(schema.toDo)
        .where(eq(schema.toDo.id, todoId))
        .limit(1)

      expect(rows[0]?.deleted).toBe(false)
      expect(rows[0]?.failureReason).toBe(null)

      const execution = yield* queryExecutionFailure(processExecutionId)
      expect(execution?.finishedAt).toBeNull()
      expect(execution?.abandonedReason).toBeNull()

      const completedJobOps = yield* CompletedJobOperations
      const isCompleted = yield* completedJobOps.isJobCompleted(
        SYSTEM_STEP_EXECUTION_QUEUE,
        job.jobId,
      )
      expect(isCompleted).toBe(false)
      expect(getNotificationJobs(enqueuedJobs)).toHaveLength(0)
    })

    await Effect.runPromise(
      Effect.provide(program, TestLayers) as Effect.Effect<void>,
    )
  })

  it("marks todo as failed when configured system step timeout exhausts retries", async () => {
    const previousTimeout = process.env["SYSTEM_STEP_EXECUTION_TIMEOUT_SECONDS"]
    process.env["SYSTEM_STEP_EXECUTION_TIMEOUT_SECONDS"] = "0.01"

    try {
      const { org } = makeTestOrg(
        Effect.sleep(Duration.millis(100)).pipe(Effect.as({})),
      )
      const { layers: TestLayers, enqueuedJobs } = createTestLayers(org)

      const program = Effect.gen(function* () {
        yield* storeOrganisation(org)
        const { todoId, stepPath, processExecutionId } =
          yield* insertExecutionWithSystemTodo

        const now = yield* DateTime.now
        const job: Job<{ todoId: string; stepPath: string }> = {
          jobId: "job-test-system-timeout-001",
          queue: SYSTEM_STEP_EXECUTION_QUEUE,
          payload: { todoId, stepPath },
          attempts: 5,
          maxAttempts: 5,
          availableAt: now,
          lockedUntil: now,
        }

        yield* systemStepExecutionHandler.handle(job)

        const db = yield* TypedSqliteDrizzle
        const rows = yield* db
          .select({
            deleted: schema.toDo._deleted,
            failureReason: schema.toDo.failureReason,
          })
          .from(schema.toDo)
          .where(eq(schema.toDo.id, todoId))
          .limit(1)

        expect(rows[0]?.deleted).toBe(false)
        expect(rows[0]?.failureReason).toContain(
          "SystemStepExecutionTimeoutError",
        )
        expect(rows[0]?.failureReason).toContain("exceeded configured timeout")

        const execution = yield* queryExecutionFailure(processExecutionId)
        expect(execution?.finishedAt).not.toBeNull()
        expect(execution?.abandonedAt).toBeNull()
        expect(execution?.abandonedReason).toContain(
          "SystemStepExecutionTimeoutError",
        )

        const completedJobOps = yield* CompletedJobOperations
        const isCompleted = yield* completedJobOps.isJobCompleted(
          SYSTEM_STEP_EXECUTION_QUEUE,
          job.jobId,
        )
        expect(isCompleted).toBe(true)
        expect(enqueuedJobs.map((job) => job.queue)).toContain(TODO_EVENT_QUEUE)
      })

      await Effect.runPromise(
        Effect.provide(program, TestLayers) as Effect.Effect<void>,
      )
    } finally {
      if (previousTimeout === undefined) {
        delete process.env["SYSTEM_STEP_EXECUTION_TIMEOUT_SECONDS"]
      } else {
        process.env["SYSTEM_STEP_EXECUTION_TIMEOUT_SECONDS"] = previousTimeout
      }
    }
  })

  it("enqueues fatal execution-failure notifications for opted-in exact role recipients", async () => {
    const { org, operator, backup } = makeExecutionFailureNotificationsOrg({
      notificationRoles: ({ operator, backup }) => [operator, backup],
      executeEffect: Effect.fail({ _tag: "TestFailure", message: "boom" }),
    })
    const { layers: TestLayers, enqueuedJobs } = createTestLayers(org)
    const previousProject = process.env["PF_PROJECT"]
    const previousEnv = process.env["PF_ENV"]

    process.env["PF_PROJECT"] = "acme"
    process.env["PF_ENV"] = "prod"

    try {
      const program = Effect.gen(function* () {
        yield* storeOrganisation(org)
        const { todoId, stepPath } = yield* insertExecutionWithSystemTodo
        const [operatorRoleId, backupRoleId] = yield* getRoleIdsByPath([
          normalizePath(operator.node.path),
          normalizePath(backup.node.path),
        ])

        yield* insertProviderUser({
          userId: "user-operator",
          providerUserId: "provider-operator",
          roleIds: [operatorRoleId],
          email: "operator@example.com",
          name: "Op Erator",
          executionFailureEmailEnabled: true,
        })
        yield* insertProviderUser({
          userId: "user-both",
          providerUserId: "provider-both",
          roleIds: [operatorRoleId, backupRoleId],
          email: "both@example.com",
          name: "Both Roles",
          executionFailureEmailEnabled: true,
        })
        yield* insertProviderUser({
          userId: "user-opted-out",
          providerUserId: "provider-opted-out",
          roleIds: [operatorRoleId],
          email: "opted-out@example.com",
          name: "Opted Out",
          executionFailureEmailEnabled: false,
        })
        yield* insertProviderUser({
          userId: "user-empty-email",
          providerUserId: "provider-empty-email",
          roleIds: [backupRoleId],
          email: "",
          name: "No Email",
          executionFailureEmailEnabled: true,
        })

        const now = yield* DateTime.now
        const job: Job<{ todoId: string; stepPath: string }> = {
          jobId: "job-test-system-notify-001",
          queue: SYSTEM_STEP_EXECUTION_QUEUE,
          payload: { todoId, stepPath },
          attempts: 5,
          maxAttempts: 5,
          availableAt: now,
          lockedUntil: now,
        }

        yield* systemStepExecutionHandler.handle(job)

        const notificationJobs = getNotificationJobs(enqueuedJobs)
        expect(notificationJobs).toHaveLength(2)
        expect(
          notificationJobs.map((job) => job.payload.recipient.userId).sort(),
        ).toEqual(["user-both", "user-operator"])

        for (const notificationJob of notificationJobs) {
          expect(notificationJob.queue).toBe(NOTIFICATION_DELIVERY_QUEUE)
          expect(notificationJob.payload.channel).toBe("email")
          if (!("executionFailure" in notificationJob.payload)) {
            throw new Error("Expected execution failure notification payload")
          }

          expect(notificationJob.payload.executionFailure).toMatchObject({
            executionId: "pex-test-system-001",
            processName: "System Step Process",
            project: "acme",
            environment: "prod",
          })
          expect(
            notificationJob.payload.executionFailure.failureReason,
          ).toContain("boom")
        }
      })

      await Effect.runPromise(
        Effect.provide(program, TestLayers) as Effect.Effect<void>,
      )
    } finally {
      if (previousProject === undefined) {
        delete process.env["PF_PROJECT"]
      } else {
        process.env["PF_PROJECT"] = previousProject
      }

      if (previousEnv === undefined) {
        delete process.env["PF_ENV"]
      } else {
        process.env["PF_ENV"] = previousEnv
      }
    }
  })

  it("treats missing or empty execution-failure notification config as a no-op", async () => {
    for (const org of [
      makeExecutionFailureNotificationsOrg().org,
      makeExecutionFailureNotificationsOrg({
        notificationRoles: () => [],
      }).org,
    ]) {
      const { layers: TestLayers, enqueuedJobs } = createTestLayers(org)

      const program = Effect.gen(function* () {
        yield* storeOrganisation(org)
        const { todoId, stepPath } = yield* insertExecutionWithSystemTodo

        const now = yield* DateTime.now
        const job: Job<{ todoId: string; stepPath: string }> = {
          jobId: `job-test-system-noop-${org.node.addr}`,
          queue: SYSTEM_STEP_EXECUTION_QUEUE,
          payload: { todoId, stepPath },
          attempts: 5,
          maxAttempts: 5,
          availableAt: now,
          lockedUntil: now,
        }

        yield* systemStepExecutionHandler.handle(job)

        expect(getNotificationJobs(enqueuedJobs)).toHaveLength(0)
      })

      await Effect.runPromise(
        Effect.provide(program, TestLayers) as Effect.Effect<void>,
      )
    }
  })

  it("marks todo as failed when infrastructure error exhausts retries", async () => {
    const { org } = makeTestOrg(Effect.succeed({}))
    const { layers: TestLayers, enqueuedJobs } = createTestLayers(org)

    const program = Effect.gen(function* () {
      yield* storeOrganisation(org)
      const { todoId, stepPath } = yield* insertExecutionWithSystemTodo

      // Corrupt the process state so getProcessStateByTodoId fails with
      // InvalidProcessStateError (valid JSON but not a Record<string, unknown>)
      const db = yield* TypedSqliteDrizzle
      yield* db
        .update(schema.processState)
        .set({ state: sql`json('[1,2,3]')` })
        .where(eq(schema.processState.id, "pst-test-system-001"))

      const now = yield* DateTime.now
      const job: Job<{ todoId: string; stepPath: string }> = {
        jobId: "job-test-infra-001",
        queue: SYSTEM_STEP_EXECUTION_QUEUE,
        payload: { todoId, stepPath },
        attempts: 5,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      }

      // Should succeed (not throw) — the outer wrapper catches and records failure
      yield* systemStepExecutionHandler.handle(job)

      // Todo should be marked as failed
      const rows = yield* db
        .select({
          deleted: schema.toDo._deleted,
          failureReason: schema.toDo.failureReason,
        })
        .from(schema.toDo)
        .where(eq(schema.toDo.id, todoId))
        .limit(1)

      expect(rows[0]?.deleted).toBe(false)
      expect(rows[0]?.failureReason).toContain("Exhausted 5 retries")

      const execution = yield* queryExecutionFailure("pex-test-system-001")
      expect(execution?.finishedAt).not.toBeNull()
      expect(execution?.abandonedAt).toBeNull()
      expect(execution?.abandonedReason).toContain("Exhausted 5 retries")

      // Job should be marked as completed (prevents dead-letter)
      const completedJobOps = yield* CompletedJobOperations
      const isCompleted = yield* completedJobOps.isJobCompleted(
        SYSTEM_STEP_EXECUTION_QUEUE,
        job.jobId,
      )
      expect(isCompleted).toBe(true)

      // Todo event should be enqueued
      expect(enqueuedJobs.map((j) => j.queue)).toContain(TODO_EVENT_QUEUE)
    })

    await Effect.runPromise(
      Effect.provide(program, TestLayers) as Effect.Effect<void>,
    )
  })

  it("merges deferred stateUpdate without completing todo", async () => {
    // A custom system step that returns Deferred with a stateUpdate
    class DeferredStep extends SystemStep {
      execute(): Effect.Effect<
        Record<string, unknown>,
        AuthorTaggedError,
        unknown
      > {
        return Effect.succeed({})
      }

      override executeStep() {
        return Effect.succeed({
          _tag: "Deferred" as const,
          stateUpdate: {
            _internal: {
              resend: {
                emailId: "re_123",
                primaryTo: "user@example.com",
                environment: "production",
                todoId: "will-be-replaced",
              },
            },
          },
        })
      }
    }

    const org = new Organisation({ name: "TestOrg" })
    const employee = new Role(org, "employee", { name: "Employee" })
    const process = new Process(org, "deferred-process", {
      name: "Deferred Process",
      purpose: "Test process for deferred state merge",
    })

    const submit = new Form(process, "submit", {
      name: "Submit",
      role: employee,
      purpose: "Submit step",
      form: () => ({}),
    })

    const deferred = new DeferredStep(process, "deferred", {
      name: "Deferred",
      purpose: "Deferred system step",
      input: () => Effect.succeed({}),
      output: {},
    })

    process.start(submit).next(deferred).end()

    const { layers: TestLayers, enqueuedJobs } = createTestLayers(org)

    const program = Effect.gen(function* () {
      yield* storeOrganisation(org)
      const { todoId, stepPath } = yield* insertExecutionWithSystemTodo

      const now = yield* DateTime.now
      const job: Job<{ todoId: string; stepPath: string }> = {
        jobId: "job-test-deferred-001",
        queue: SYSTEM_STEP_EXECUTION_QUEUE,
        payload: { todoId, stepPath },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      }

      yield* systemStepExecutionHandler.handle(job)

      const db = yield* TypedSqliteDrizzle

      // Todo should NOT be completed (deferred means it stays open)
      const todos = yield* db
        .select({
          deleted: schema.toDo._deleted,
          failureReason: schema.toDo.failureReason,
        })
        .from(schema.toDo)
        .where(eq(schema.toDo.id, todoId))
        .limit(1)

      expect(todos[0]?.deleted).toBe(false)
      expect(todos[0]?.failureReason).toBe(null)

      // Process state should contain the deferred metadata
      const states = yield* db
        .select({ state: schema.processState.state })
        .from(schema.processState)
        .where(eq(schema.processState.id, "pst-test-system-001"))
        .limit(1)

      const state = states[0]?.state
      expect(state).toBeDefined()
      const internal = (state as Record<string, unknown>)["_internal"]
      expect(internal).toBeDefined()
      const resend = (internal as Record<string, unknown>)["resend"]
      expect(resend).toBeDefined()
      expect((resend as Record<string, unknown>)["emailId"]).toBe("re_123")
      expect((resend as Record<string, unknown>)["primaryTo"]).toBe(
        "user@example.com",
      )
      expect((resend as Record<string, unknown>)["environment"]).toBe(
        "production",
      )

      // Job should be marked as completed
      const completedJobOps = yield* CompletedJobOperations
      const isCompleted = yield* completedJobOps.isJobCompleted(
        SYSTEM_STEP_EXECUTION_QUEUE,
        job.jobId,
      )
      expect(isCompleted).toBe(true)

      // No flow-execution or todo-event should be enqueued (todo not completed)
      const queues = enqueuedJobs.map((j) => j.queue)
      expect(queues).not.toContain(TODO_EVENT_QUEUE)
      expect(queues).not.toContain(FLOW_EXECUTION_QUEUE)
    })

    await Effect.runPromise(
      Effect.provide(program, TestLayers) as Effect.Effect<void>,
    )
  })

  it("recovers a failed async todo into completed and clears the failure reason", async () => {
    const { org } = makeTestOrg(Effect.succeed({ emailId: "re_email_123" }))
    const { layers: TestLayers, enqueuedJobs } = createTestLayers(org)

    const program = Effect.gen(function* () {
      yield* storeOrganisation(org)
      const { todoId, stepPath } = yield* insertExecutionWithSystemTodo
      const todoInfo = yield* loadTodoInfo(todoId)

      const queueService = yield* QueueService
      const stepCompletionOps = yield* StepCompletionOperations
      const flowExecutionOps = yield* FlowExecutionOperations
      const scheduledFlowOps = yield* ScheduledFlowOperations
      const calendarQueries = yield* BusinessCalendarQueries
      const sqlClient = yield* SqlClient.SqlClient

      const didFail = yield* failAsyncSystemStep({
        todoId,
        processExecutionId: todoInfo.processExecutionId,
        failureReason: "Resend reported email.failed for the primary recipient",
        queueService,
        stepCompletionOps,
        scheduledFlowOps,
        flowExecutionOps,
        sqlClient,
      })
      expect(didFail.didFail).toBe(true)

      const didComplete = yield* completeAsyncSystemStep({
        todoId,
        stepPath,
        output: { emailId: "re_email_123" },
        todoInfo,
        isForEach: false,
        queueService,
        stepCompletionOps,
        scheduledFlowOps,
        flowExecutionOps,
        calendarQueries,
        sqlClient,
      })
      expect(didComplete).toBe(true)

      const db = yield* TypedSqliteDrizzle
      const rows = yield* db
        .select({
          deleted: schema.toDo._deleted,
          failureReason: schema.toDo.failureReason,
        })
        .from(schema.toDo)
        .where(eq(schema.toDo.id, todoId))
        .limit(1)

      expect(rows[0]?.deleted).toBe(true)
      expect(rows[0]?.failureReason).toBe(null)

      const states = yield* db
        .select({ state: schema.processState.state })
        .from(schema.processState)
        .where(eq(schema.processState.id, todoInfo.processStateId))
        .limit(1)

      expect(states[0]?.state).toEqual({ emailId: "re_email_123" })
      expect(
        enqueuedJobs.filter((job) => job.queue === FLOW_EXECUTION_QUEUE),
      ).toHaveLength(1)
    })

    await Effect.runPromise(
      Effect.provide(program, TestLayers) as Effect.Effect<void>,
    )
  })

  it("only progresses async completion once for duplicate delivery callbacks", async () => {
    const { org } = makeTestOrg(Effect.succeed({ emailId: "re_email_123" }))
    const { layers: TestLayers, enqueuedJobs } = createTestLayers(org)

    const program = Effect.gen(function* () {
      yield* storeOrganisation(org)
      const { todoId, stepPath } = yield* insertExecutionWithSystemTodo
      const todoInfo = yield* loadTodoInfo(todoId)

      const queueService = yield* QueueService
      const stepCompletionOps = yield* StepCompletionOperations
      const flowExecutionOps = yield* FlowExecutionOperations
      const scheduledFlowOps = yield* ScheduledFlowOperations
      const calendarQueries = yield* BusinessCalendarQueries
      const sqlClient = yield* SqlClient.SqlClient

      const firstCompletion = yield* completeAsyncSystemStep({
        todoId,
        stepPath,
        output: { emailId: "re_email_123" },
        todoInfo,
        isForEach: false,
        queueService,
        stepCompletionOps,
        scheduledFlowOps,
        flowExecutionOps,
        calendarQueries,
        sqlClient,
      })
      const duplicateCompletion = yield* completeAsyncSystemStep({
        todoId,
        stepPath,
        output: { emailId: "re_email_123" },
        todoInfo,
        isForEach: false,
        queueService,
        stepCompletionOps,
        scheduledFlowOps,
        flowExecutionOps,
        calendarQueries,
        sqlClient,
      })

      expect(firstCompletion).toBe(true)
      expect(duplicateCompletion).toBe(false)

      const db = yield* TypedSqliteDrizzle
      const scheduledFlows = yield* db
        .select({ id: schema.scheduledFlow.id })
        .from(schema.scheduledFlow)
        .where(
          eq(
            schema.scheduledFlow.processExecutionId,
            todoInfo.processExecutionId,
          ),
        )

      expect(scheduledFlows).toHaveLength(1)
      expect(
        enqueuedJobs.filter((job) => job.queue === FLOW_EXECUTION_QUEUE),
      ).toHaveLength(1)
      expect(
        enqueuedJobs.filter((job) => job.queue === TODO_EVENT_QUEUE),
      ).toHaveLength(1)
    })

    await Effect.runPromise(
      Effect.provide(program, TestLayers) as Effect.Effect<void>,
    )
  })

  it("ignores async failure callbacks once the todo is completed", async () => {
    const { org } = makeTestOrg(Effect.succeed({ emailId: "re_email_123" }))
    const { layers: TestLayers, enqueuedJobs } = createTestLayers(org)

    const program = Effect.gen(function* () {
      yield* storeOrganisation(org)
      const { todoId, stepPath } = yield* insertExecutionWithSystemTodo
      const todoInfo = yield* loadTodoInfo(todoId)

      const queueService = yield* QueueService
      const stepCompletionOps = yield* StepCompletionOperations
      const flowExecutionOps = yield* FlowExecutionOperations
      const scheduledFlowOps = yield* ScheduledFlowOperations
      const calendarQueries = yield* BusinessCalendarQueries
      const sqlClient = yield* SqlClient.SqlClient

      const didComplete = yield* completeAsyncSystemStep({
        todoId,
        stepPath,
        output: { emailId: "re_email_123" },
        todoInfo,
        isForEach: false,
        queueService,
        stepCompletionOps,
        scheduledFlowOps,
        flowExecutionOps,
        calendarQueries,
        sqlClient,
      })
      const didFail = yield* failAsyncSystemStep({
        todoId,
        processExecutionId: todoInfo.processExecutionId,
        failureReason: "Resend reported email.failed for the primary recipient",
        queueService,
        stepCompletionOps,
        scheduledFlowOps,
        flowExecutionOps,
        sqlClient,
      })

      expect(didComplete).toBe(true)
      expect(didFail.didFail).toBe(false)

      const db = yield* TypedSqliteDrizzle
      const rows = yield* db
        .select({
          deleted: schema.toDo._deleted,
          failureReason: schema.toDo.failureReason,
        })
        .from(schema.toDo)
        .where(eq(schema.toDo.id, todoId))
        .limit(1)

      expect(rows[0]?.deleted).toBe(true)
      expect(rows[0]?.failureReason).toBe(null)
      expect(
        enqueuedJobs.filter((job) => job.queue === TODO_EVENT_QUEUE),
      ).toHaveLength(1)
    })

    await Effect.runPromise(
      Effect.provide(program, TestLayers) as Effect.Effect<void>,
    )
  })

  it("ignores later async failure callbacks after the first failure is recorded", async () => {
    const { org } = makeTestOrg(Effect.succeed({ emailId: "re_email_123" }))
    const { layers: TestLayers, enqueuedJobs } = createTestLayers(org)

    const program = Effect.gen(function* () {
      yield* storeOrganisation(org)
      const { todoId } = yield* insertExecutionWithSystemTodo
      const todoInfo = yield* loadTodoInfo(todoId)

      const queueService = yield* QueueService
      const stepCompletionOps = yield* StepCompletionOperations
      const flowExecutionOps = yield* FlowExecutionOperations
      const scheduledFlowOps = yield* ScheduledFlowOperations
      const sqlClient = yield* SqlClient.SqlClient

      const firstFailure = yield* failAsyncSystemStep({
        todoId,
        processExecutionId: todoInfo.processExecutionId,
        failureReason: "Resend reported email.failed for the primary recipient",
        queueService,
        stepCompletionOps,
        scheduledFlowOps,
        flowExecutionOps,
        sqlClient,
      })
      const duplicateFailure = yield* failAsyncSystemStep({
        todoId,
        processExecutionId: todoInfo.processExecutionId,
        failureReason:
          "Resend reported email.bounced for the primary recipient",
        queueService,
        stepCompletionOps,
        scheduledFlowOps,
        flowExecutionOps,
        sqlClient,
      })

      expect(firstFailure.didFail).toBe(true)
      expect(duplicateFailure.didFail).toBe(false)
      expect(
        enqueuedJobs.filter((job) => job.queue === TODO_EVENT_QUEUE),
      ).toHaveLength(1)
    })

    await Effect.runPromise(
      Effect.provide(program, TestLayers) as Effect.Effect<void>,
    )
  })

  it("creates catch-all recovery todos for async failures through the normal flow pipeline", async () => {
    const { org, paths } = makeCatchAllOnErrorTestOrg(Effect.succeed({}))
    const { layers: TestLayers, enqueuedJobs } = createTestLayers(org)

    const program = Effect.gen(function* () {
      yield* storeOrganisation(org)
      const { todoId } = yield* insertExecutionWithSystemTodo
      const todoInfo = yield* loadTodoInfo(todoId)

      const queueService = yield* QueueService
      const stepCompletionOps = yield* StepCompletionOperations
      const flowExecutionOps = yield* FlowExecutionOperations
      const scheduledFlowOps = yield* ScheduledFlowOperations
      const sqlClient = yield* SqlClient.SqlClient

      const didFail = yield* failAsyncSystemStep({
        todoId,
        processExecutionId: todoInfo.processExecutionId,
        failureReason: "Resend reported email.failed for the primary recipient",
        queueService,
        stepCompletionOps,
        scheduledFlowOps,
        flowExecutionOps,
        sqlClient,
      })

      expect(didFail.didFail).toBe(true)
      expect(didFail.scheduledFlowId).toEqual(expect.any(String))

      const flowPayload = enqueuedJobs.find(
        (queuedJob) => queuedJob.queue === FLOW_EXECUTION_QUEUE,
      )?.payload as
        | { scheduledFlowId: string; onError?: boolean; errorTag?: string }
        | undefined

      expect(flowPayload).toBeDefined()
      expect(flowPayload).toMatchObject({ onError: true })
      expect(flowPayload?.errorTag).toBeUndefined()

      const execution = yield* queryExecutionFailure(
        todoInfo.processExecutionId,
      )
      expect(execution?.finishedAt).toBeNull()
      expect(execution?.abandonedReason).toBeNull()

      const now = yield* DateTime.now
      const flowJob: Job<{
        scheduledFlowId: string
        onError?: boolean
        errorTag?: string
      }> = {
        jobId: "job-test-flow-async-onerror-catch-all-001",
        queue: FLOW_EXECUTION_QUEUE,
        payload: flowPayload!,
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      }

      yield* flowExecutionHandler.handle(flowJob)

      const db = yield* TypedSqliteDrizzle
      const originalTodo = yield* db
        .select({
          deleted: schema.toDo._deleted,
          failureReason: schema.toDo.failureReason,
        })
        .from(schema.toDo)
        .where(eq(schema.toDo.id, todoId))
        .limit(1)

      expect(originalTodo[0]?.deleted).toBe(false)
      expect(originalTodo[0]?.failureReason).toContain("email.failed")

      const todoTargets = yield* db
        .select({
          todoId: schema.toDo.id,
          targetPath: schema.step.path,
          failureReason: schema.toDo.failureReason,
        })
        .from(schema.toDo)
        .innerJoin(schema.flow, eq(schema.toDo.flowId, schema.flow.id))
        .innerJoin(schema.step, eq(schema.flow.targetStepId, schema.step.id))

      expect(todoTargets).toEqual(
        expect.arrayContaining([
          {
            todoId,
            targetPath: paths.system,
            failureReason: expect.stringContaining("email.failed"),
          },
          {
            todoId: expect.any(String),
            targetPath: paths.recover,
            failureReason: null,
          },
        ]),
      )
      expect(todoTargets).toHaveLength(2)
    })

    await Effect.runPromise(
      Effect.provide(program, TestLayers) as Effect.Effect<void>,
    )
  })

  it("prefers tagged async onError branches over catch-all recovery", async () => {
    const { org, paths } = makeOutermostTaggedOnErrorTestOrg(Effect.succeed({}))
    const { layers: TestLayers, enqueuedJobs } = createTestLayers(org)

    const program = Effect.gen(function* () {
      yield* storeOrganisation(org)
      const { todoId } = yield* insertExecutionWithSystemTodo
      const todoInfo = yield* loadTodoInfo(todoId)

      const queueService = yield* QueueService
      const stepCompletionOps = yield* StepCompletionOperations
      const flowExecutionOps = yield* FlowExecutionOperations
      const scheduledFlowOps = yield* ScheduledFlowOperations
      const sqlClient = yield* SqlClient.SqlClient

      const didFail = yield* failAsyncSystemStep({
        todoId,
        processExecutionId: todoInfo.processExecutionId,
        failureReason: "Retryable async callback failed",
        errorTag: "Retryable",
        queueService,
        stepCompletionOps,
        scheduledFlowOps,
        flowExecutionOps,
        sqlClient,
      })

      expect(didFail.didFail).toBe(true)
      expect(didFail.scheduledFlowId).toEqual(expect.any(String))

      const flowPayload = enqueuedJobs.find(
        (queuedJob) => queuedJob.queue === FLOW_EXECUTION_QUEUE,
      )?.payload as
        | { scheduledFlowId: string; onError?: boolean; errorTag?: string }
        | undefined

      expect(flowPayload).toBeDefined()
      expect(flowPayload).toMatchObject({
        onError: true,
        errorTag: "Retryable",
      })

      const now = yield* DateTime.now
      const flowJob: Job<{
        scheduledFlowId: string
        onError?: boolean
        errorTag?: string
      }> = {
        jobId: "job-test-flow-async-onerror-tagged-001",
        queue: FLOW_EXECUTION_QUEUE,
        payload: flowPayload!,
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      }

      yield* flowExecutionHandler.handle(flowJob)

      const db = yield* TypedSqliteDrizzle
      const todoTargets = yield* db
        .select({ targetPath: schema.step.path })
        .from(schema.toDo)
        .innerJoin(schema.flow, eq(schema.toDo.flowId, schema.flow.id))
        .innerJoin(schema.step, eq(schema.flow.targetStepId, schema.step.id))

      expect(todoTargets).toEqual(
        expect.arrayContaining([
          { targetPath: paths.system },
          { targetPath: paths.outerRecover },
        ]),
      )
      expect(todoTargets).not.toContainEqual({ targetPath: paths.innerRecover })
      expect(todoTargets).not.toContainEqual({
        targetPath: paths.catchAllRecover,
      })
      expect(todoTargets).toHaveLength(2)
    })

    await Effect.runPromise(
      Effect.provide(program, TestLayers) as Effect.Effect<void>,
    )
  })

  it("does not enqueue async onError flow execution when no error branch matches", async () => {
    const { org } = makeOnErrorTestOrg(Effect.succeed({}))
    const { layers: TestLayers, enqueuedJobs } = createTestLayers(org)

    const program = Effect.gen(function* () {
      yield* storeOrganisation(org)
      const { todoId } = yield* insertExecutionWithSystemTodo
      const todoInfo = yield* loadTodoInfo(todoId)

      const queueService = yield* QueueService
      const stepCompletionOps = yield* StepCompletionOperations
      const flowExecutionOps = yield* FlowExecutionOperations
      const scheduledFlowOps = yield* ScheduledFlowOperations
      const sqlClient = yield* SqlClient.SqlClient

      const didFail = yield* failAsyncSystemStep({
        todoId,
        processExecutionId: todoInfo.processExecutionId,
        failureReason: "Resend reported email.failed for the primary recipient",
        queueService,
        stepCompletionOps,
        scheduledFlowOps,
        flowExecutionOps,
        sqlClient,
      })

      expect(didFail).toEqual({ didFail: true, scheduledFlowId: null })
      expect(enqueuedJobs.map((queuedJob) => queuedJob.queue)).not.toContain(
        FLOW_EXECUTION_QUEUE,
      )

      const db = yield* TypedSqliteDrizzle
      const rows = yield* db
        .select({
          deleted: schema.toDo._deleted,
          failureReason: schema.toDo.failureReason,
        })
        .from(schema.toDo)
        .where(eq(schema.toDo.id, todoId))
        .limit(1)

      expect(rows[0]?.deleted).toBe(false)
      expect(rows[0]?.failureReason).toContain("email.failed")

      // Deferred callback failures record Todo evidence only. Closing the
      // execution here would block a later success callback from advancing
      // the same Todo (see recover-into-completed).
      const execution = yield* queryExecutionFailure(
        todoInfo.processExecutionId,
      )
      expect(execution?.finishedAt).toBeNull()
      expect(execution?.abandonedReason).toBeNull()
    })

    await Effect.runPromise(
      Effect.provide(program, TestLayers) as Effect.Effect<void>,
    )
  })

  it("closes the execution on a terminal Docker-style failure with no error branch", async () => {
    const { org } = makeTestOrg(Effect.succeed({}))
    const { layers: TestLayers, enqueuedJobs } = createTestLayers(org)

    const program = Effect.gen(function* () {
      yield* storeOrganisation(org)
      const { todoId } = yield* insertExecutionWithSystemTodo
      const todoInfo = yield* loadTodoInfo(todoId)

      const completedJobOps = yield* CompletedJobOperations
      const queueService = yield* QueueService
      const stepCompletionOps = yield* StepCompletionOperations
      const flowExecutionOps = yield* FlowExecutionOperations
      const scheduledFlowOps = yield* ScheduledFlowOperations
      const sqlClient = yield* SqlClient.SqlClient

      const didFail = yield* failTerminalSystemStep({
        todoId,
        processExecutionId: todoInfo.processExecutionId,
        failureReason: "Step failed.",
        completedJob: {
          ops: completedJobOps,
          namespace: "docker-step-complete",
          jobId: "project:build-1",
        },
        queueService,
        stepCompletionOps,
        scheduledFlowOps,
        flowExecutionOps,
        sqlClient,
      })

      expect(didFail).toEqual({
        didFail: true,
        scheduledFlowId: null,
        closedExecution: true,
      })
      expect(enqueuedJobs.map((queuedJob) => queuedJob.queue)).not.toContain(
        FLOW_EXECUTION_QUEUE,
      )

      const db = yield* TypedSqliteDrizzle
      const todoRows = yield* db
        .select({
          deleted: schema.toDo._deleted,
          failureReason: schema.toDo.failureReason,
        })
        .from(schema.toDo)
        .where(eq(schema.toDo.id, todoId))
        .limit(1)

      expect(todoRows[0]?.deleted).toBe(false)
      expect(todoRows[0]?.failureReason).toBe("Step failed.")

      const execution = yield* queryExecutionFailure(
        todoInfo.processExecutionId,
      )
      expect(execution?.finishedAt).not.toBeNull()
      expect(execution?.abandonedAt).toBeNull()
      expect(execution?.abandonedReason).toBe("Step failed.")

      const completedJobOpsAfter = yield* CompletedJobOperations
      expect(
        yield* completedJobOpsAfter.isJobCompleted(
          "docker-step-complete",
          "project:build-1",
        ),
      ).toBe(true)
    })

    await Effect.runPromise(
      Effect.provide(program, TestLayers) as Effect.Effect<void>,
    )
  })

  it("keeps the execution running on a terminal Docker-style failure with a matching error branch", async () => {
    const { org } = makeCatchAllOnErrorTestOrg(Effect.succeed({}))
    const { layers: TestLayers, enqueuedJobs } = createTestLayers(org)

    const program = Effect.gen(function* () {
      yield* storeOrganisation(org)
      const { todoId } = yield* insertExecutionWithSystemTodo
      const todoInfo = yield* loadTodoInfo(todoId)

      const completedJobOps = yield* CompletedJobOperations
      const queueService = yield* QueueService
      const stepCompletionOps = yield* StepCompletionOperations
      const flowExecutionOps = yield* FlowExecutionOperations
      const scheduledFlowOps = yield* ScheduledFlowOperations
      const sqlClient = yield* SqlClient.SqlClient

      const didFail = yield* failTerminalSystemStep({
        todoId,
        processExecutionId: todoInfo.processExecutionId,
        failureReason: "Step failed.",
        completedJob: {
          ops: completedJobOps,
          namespace: "docker-step-complete",
          jobId: "project:build-2",
        },
        queueService,
        stepCompletionOps,
        scheduledFlowOps,
        flowExecutionOps,
        sqlClient,
      })

      expect(didFail.didFail).toBe(true)
      if (didFail.didFail) {
        expect(didFail.closedExecution).toBe(false)
        expect(didFail.scheduledFlowId).toEqual(expect.any(String))
      }
      expect(
        enqueuedJobs.some(
          (queuedJob) => queuedJob.queue === FLOW_EXECUTION_QUEUE,
        ),
      ).toBe(true)

      const execution = yield* queryExecutionFailure(
        todoInfo.processExecutionId,
      )
      expect(execution?.finishedAt).toBeNull()
      expect(execution?.abandonedReason).toBeNull()
    })

    await Effect.runPromise(
      Effect.provide(program, TestLayers) as Effect.Effect<void>,
    )
  })

  it("closes the execution on a terminal forEach item and leaves completed siblings plus the barrier", async () => {
    const { org } = makeForEachSystemStepOrg((input) =>
      input.recipient === "first"
        ? Effect.fail({
            _tag: "TestFailure",
            message: "account boom",
            retryable: false,
          })
        : Effect.succeed(input),
    )
    const { layers: TestLayers, enqueuedJobs } = createTestLayers(org)

    const program = Effect.gen(function* () {
      yield* storeOrganisation(org)
      const { todoIds, stepPath, processExecutionId } =
        yield* insertExecutionWithForEachSystemTodos
      const [failedTodoId, siblingTodoId] = todoIds
      const now = yield* DateTime.now

      yield* systemStepExecutionHandler.handle({
        jobId: "job-test-foreach-fail-001",
        queue: SYSTEM_STEP_EXECUTION_QUEUE,
        payload: { todoId: failedTodoId, stepPath },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      })

      const executionAfterFailure =
        yield* queryExecutionFailure(processExecutionId)
      expect(executionAfterFailure?.finishedAt).not.toBeNull()
      expect(executionAfterFailure?.abandonedAt).toBeNull()
      expect(executionAfterFailure?.abandonedReason).toContain("account boom")

      yield* systemStepExecutionHandler.handle({
        jobId: "job-test-foreach-ok-001",
        queue: SYSTEM_STEP_EXECUTION_QUEUE,
        payload: { todoId: siblingTodoId, stepPath },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      })

      const flowPayload = enqueuedJobs.find(
        (queuedJob) => queuedJob.queue === FLOW_EXECUTION_QUEUE,
      )?.payload as { scheduledFlowId: string } | undefined
      expect(flowPayload?.scheduledFlowId).toEqual(expect.any(String))

      yield* flowExecutionHandler.handle({
        jobId: "job-test-foreach-barrier-001",
        queue: FLOW_EXECUTION_QUEUE,
        payload: flowPayload!,
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      })

      const db = yield* TypedSqliteDrizzle
      const todos = yield* db
        .select({
          id: schema.toDo.id,
          deleted: schema.toDo._deleted,
          failureReason: schema.toDo.failureReason,
        })
        .from(schema.toDo)
        .where(eq(schema.toDo.processExecutionId, processExecutionId))

      expect(todos).toEqual(
        expect.arrayContaining([
          {
            id: failedTodoId,
            deleted: false,
            failureReason: expect.stringContaining("account boom"),
          },
          {
            id: siblingTodoId,
            deleted: true,
            failureReason: null,
          },
        ]),
      )
      expect(todos).toHaveLength(2)

      const barriers = yield* db
        .select({
          id: schema.scheduledFlow.id,
          forEachBarrier: schema.scheduledFlow.forEachBarrier,
        })
        .from(schema.scheduledFlow)
        .where(eq(schema.scheduledFlow.processExecutionId, processExecutionId))

      expect(barriers).toEqual([
        {
          id: flowPayload!.scheduledFlowId,
          forEachBarrier: true,
        },
      ])

      const execution = yield* queryExecutionFailure(processExecutionId)
      expect(execution?.finishedAt).not.toBeNull()
      expect(execution?.abandonedReason).toContain("account boom")
    })

    await Effect.runPromise(
      Effect.provide(program, TestLayers) as Effect.Effect<void>,
    )
  })

  it("appends async forEach completions without overwriting sibling outputs", async () => {
    const { org } = makeForEachSystemStepOrg()
    const { layers: TestLayers } = createTestLayers(org)

    const program = Effect.gen(function* () {
      yield* storeOrganisation(org)
      const { todoIds, stepPath, processStateId } =
        yield* insertExecutionWithForEachSystemTodos
      const [firstTodoId, secondTodoId] = todoIds

      const firstTodoInfo = yield* loadTodoInfo(firstTodoId)
      const secondTodoInfo = yield* loadTodoInfo(secondTodoId)

      const queueService = yield* QueueService
      const stepCompletionOps = yield* StepCompletionOperations
      const flowExecutionOps = yield* FlowExecutionOperations
      const scheduledFlowOps = yield* ScheduledFlowOperations
      const calendarQueries = yield* BusinessCalendarQueries
      const sqlClient = yield* SqlClient.SqlClient

      const firstCompletion = yield* completeAsyncSystemStep({
        todoId: firstTodoId,
        stepPath,
        output: { recipient: "first@example.com" },
        todoInfo: firstTodoInfo,
        isForEach: true,
        queueService,
        stepCompletionOps,
        scheduledFlowOps,
        flowExecutionOps,
        calendarQueries,
        sqlClient,
      })
      const secondCompletion = yield* completeAsyncSystemStep({
        todoId: secondTodoId,
        stepPath,
        output: { recipient: "second@example.com" },
        todoInfo: secondTodoInfo,
        isForEach: true,
        queueService,
        stepCompletionOps,
        scheduledFlowOps,
        flowExecutionOps,
        calendarQueries,
        sqlClient,
      })

      expect(firstCompletion).toBe(true)
      expect(secondCompletion).toBe(true)

      const db = yield* TypedSqliteDrizzle
      const states = yield* db
        .select({ state: schema.processState.state })
        .from(schema.processState)
        .where(eq(schema.processState.id, processStateId))
        .limit(1)

      expect(states[0]?.state).toEqual({
        sendbatch: [
          { recipient: "first@example.com" },
          { recipient: "second@example.com" },
        ],
      })
    })

    await Effect.runPromise(
      Effect.provide(program, TestLayers) as Effect.Effect<void>,
    )
  })

  it("rechecks a forEach barrier when the deterministic flow job is delivered again", async () => {
    const { org } = makeForEachSystemStepOrg()
    const { layers: TestLayers, enqueuedJobs } = createTestLayers(org, {
      queueInTransaction: false,
    })

    const program = Effect.gen(function* () {
      yield* storeOrganisation(org)
      const { todoIds, stepPath, processExecutionId } =
        yield* insertExecutionWithForEachSystemTodos
      const [firstTodoId, secondTodoId] = todoIds
      const now = yield* DateTime.now

      yield* systemStepExecutionHandler.handle({
        jobId: "job-test-foreach-first-001",
        queue: SYSTEM_STEP_EXECUTION_QUEUE,
        payload: { todoId: firstTodoId, stepPath },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      })

      const firstFlowJob = enqueuedJobs.find(
        (queuedJob) => queuedJob.queue === FLOW_EXECUTION_QUEUE,
      )
      if (!firstFlowJob?.logicalJobId) {
        throw new Error("Expected first barrier flow job")
      }
      const flowPayload = firstFlowJob.payload as
        | { scheduledFlowId: string }
        | undefined
      expect(flowPayload?.scheduledFlowId).toEqual(expect.any(String))

      const barrierJobId = `test-queue|${firstFlowJob.logicalJobId}`
      const firstBarrierJob = {
        jobId: barrierJobId,
        queue: FLOW_EXECUTION_QUEUE,
        payload: flowPayload!,
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      } as const

      yield* flowExecutionHandler.handle(firstBarrierJob)

      const completedJobOps = yield* CompletedJobOperations
      expect(
        yield* completedJobOps.isJobCompleted(
          FLOW_EXECUTION_QUEUE,
          barrierJobId,
        ),
      ).toBe(false)

      // Simulate the marker persisted by the previous implementation after an
      // early barrier check while the barrier row remained live.
      yield* completedJobOps.markJobCompleted(
        FLOW_EXECUTION_QUEUE,
        barrierJobId,
      )

      yield* systemStepExecutionHandler.handle({
        jobId: "job-test-foreach-second-001",
        queue: SYSTEM_STEP_EXECUTION_QUEUE,
        payload: { todoId: secondTodoId, stepPath },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      })
      const barrierFlowJobs = enqueuedJobs.filter(
        (queuedJob) => queuedJob.queue === FLOW_EXECUTION_QUEUE,
      )
      const secondFlowJob = barrierFlowJobs[1]
      expect(secondFlowJob?.logicalJobId).toBe(firstFlowJob.logicalJobId)
      yield* flowExecutionHandler.handle({
        ...firstBarrierJob,
        jobId: `test-queue|${secondFlowJob?.logicalJobId}`,
        payload: secondFlowJob?.payload as { scheduledFlowId: string },
      })

      expect(
        yield* completedJobOps.isJobCompleted(
          FLOW_EXECUTION_QUEUE,
          barrierJobId,
        ),
      ).toBe(true)

      const execution = yield* queryExecutionFailure(processExecutionId)
      expect(execution?.finishedAt).not.toBeNull()
      expect(execution?.abandonedReason).toBeNull()
    })

    await Effect.runPromise(
      Effect.provide(program, TestLayers) as Effect.Effect<void>,
    )
  })

  it("executes a started system step and schedules downstream flow evaluation", async () => {
    const { org } = makeStartSystemStepOrg(
      Effect.succeed({ greeting: "hello" }),
    )
    const { layers: TestLayers, enqueuedJobs } = createTestLayers(org)

    const program = Effect.gen(function* () {
      yield* storeOrganisation(org)
      const { processExecutionId, stepId, stepPath } =
        yield* insertExecutionForStartSystemStep

      const now = yield* DateTime.now
      const job: Job<{
        startsProcess: true
        processExecutionId: string
        stepId: string
        stepPath: string
      }> = {
        jobId: "job-test-start-system-001",
        queue: SYSTEM_STEP_EXECUTION_QUEUE,
        payload: {
          startsProcess: true,
          processExecutionId,
          stepId,
          stepPath,
        },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      }

      yield* systemStepExecutionHandler.handle(job)

      const db = yield* TypedSqliteDrizzle
      const states = yield* db
        .select({ state: schema.processState.state })
        .from(schema.processState)
        .where(eq(schema.processState.id, "pst-test-start-system-001"))
        .limit(1)

      expect(states[0]?.state).toEqual({ greeting: "hello" })

      const scheduledFlows = yield* db
        .select({
          processExecutionId: schema.scheduledFlow.processExecutionId,
          sourceStepId: schema.scheduledFlow.sourceStepId,
        })
        .from(schema.scheduledFlow)
        .where(eq(schema.scheduledFlow.processExecutionId, processExecutionId))

      expect(scheduledFlows).toEqual([
        { processExecutionId, sourceStepId: stepId },
      ])
      const completedJobOps = yield* CompletedJobOperations
      const isCompleted = yield* completedJobOps.isJobCompleted(
        SYSTEM_STEP_EXECUTION_QUEUE,
        `start-${processExecutionId}`,
      )
      expect(isCompleted).toBe(true)

      const queues = enqueuedJobs.map((queuedJob) => queuedJob.queue)
      expect(queues).toContain(FLOW_EXECUTION_QUEUE)
      expect(queues).toContain(PROCESS_EVENT_QUEUE)
      expect(queues).toContain(EXECUTION_EVENT_QUEUE)
      expect(queues).not.toContain(TODO_EVENT_QUEUE)
    })

    await Effect.runPromise(
      Effect.provide(program, TestLayers) as Effect.Effect<void>,
    )
  })

  it("marks started system step executions failed on terminal failure", async () => {
    const { org } = makeStartSystemStepOrg(
      Effect.fail({ _tag: "TestFailure", message: "boom" }),
    )
    const { layers: TestLayers, enqueuedJobs } = createTestLayers(org)

    const program = Effect.gen(function* () {
      yield* storeOrganisation(org)
      const { processExecutionId, stepId, stepPath } =
        yield* insertExecutionForStartSystemStep

      const now = yield* DateTime.now
      const job: Job<{
        startsProcess: true
        processExecutionId: string
        stepId: string
        stepPath: string
      }> = {
        jobId: "job-test-start-system-002",
        queue: SYSTEM_STEP_EXECUTION_QUEUE,
        payload: {
          startsProcess: true,
          processExecutionId,
          stepId,
          stepPath,
        },
        attempts: 5,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      }

      yield* systemStepExecutionHandler.handle(job)

      const db = yield* TypedSqliteDrizzle
      const executions = yield* db
        .select({
          finishedAt: schema.processExecution.finishedAt,
          abandonedAt: schema.processExecution.abandonedAt,
          abandonedReason: schema.processExecution.abandonedReason,
        })
        .from(schema.processExecution)
        .where(eq(schema.processExecution.id, processExecutionId))
        .limit(1)

      expect(executions[0]?.finishedAt).not.toBeNull()
      expect(executions[0]?.abandonedAt).toBeNull()
      expect(executions[0]?.abandonedReason).toContain("boom")

      const scheduledFlows = yield* db
        .select({ id: schema.scheduledFlow.id })
        .from(schema.scheduledFlow)
        .where(eq(schema.scheduledFlow.processExecutionId, processExecutionId))

      expect(scheduledFlows).toEqual([])

      const completedJobOps = yield* CompletedJobOperations
      const isCompleted = yield* completedJobOps.isJobCompleted(
        SYSTEM_STEP_EXECUTION_QUEUE,
        `start-${processExecutionId}`,
      )
      expect(isCompleted).toBe(true)

      const queues = enqueuedJobs.map((queuedJob) => queuedJob.queue)
      expect(queues).toContain(PROCESS_EVENT_QUEUE)
      expect(queues).toContain(EXECUTION_EVENT_QUEUE)
      expect(queues).not.toContain(FLOW_EXECUTION_QUEUE)
      expect(queues).not.toContain(TODO_EVENT_QUEUE)
      expect(getNotificationJobs(enqueuedJobs)).toHaveLength(0)
    })

    await Effect.runPromise(
      Effect.provide(program, TestLayers) as Effect.Effect<void>,
    )
  })

  it("re-raises started system step failures while retries remain", async () => {
    const { org } = makeStartSystemStepOrg(
      Effect.fail({ _tag: "TestFailure", message: "retry" }),
    )
    const { layers: TestLayers, enqueuedJobs } = createTestLayers(org)

    const program = Effect.gen(function* () {
      yield* storeOrganisation(org)
      const { processExecutionId, stepId, stepPath } =
        yield* insertExecutionForStartSystemStep

      const now = yield* DateTime.now
      const job: Job<{
        startsProcess: true
        processExecutionId: string
        stepId: string
        stepPath: string
      }> = {
        jobId: "job-test-start-system-003",
        queue: SYSTEM_STEP_EXECUTION_QUEUE,
        payload: {
          startsProcess: true,
          processExecutionId,
          stepId,
          stepPath,
        },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      }

      const exit = yield* Effect.exit(systemStepExecutionHandler.handle(job))
      expect(Exit.isFailure(exit)).toBe(true)

      const db = yield* TypedSqliteDrizzle
      const executions = yield* db
        .select({ finishedAt: schema.processExecution.finishedAt })
        .from(schema.processExecution)
        .where(eq(schema.processExecution.id, processExecutionId))
        .limit(1)

      expect(executions[0]?.finishedAt).toBeNull()

      const scheduledFlows = yield* db
        .select({ id: schema.scheduledFlow.id })
        .from(schema.scheduledFlow)
        .where(eq(schema.scheduledFlow.processExecutionId, processExecutionId))

      expect(scheduledFlows).toEqual([])

      const completedJobOps = yield* CompletedJobOperations
      const isCompleted = yield* completedJobOps.isJobCompleted(
        SYSTEM_STEP_EXECUTION_QUEUE,
        job.jobId,
      )
      expect(isCompleted).toBe(false)
      expect(getNotificationJobs(enqueuedJobs)).toHaveLength(0)
    })

    await Effect.runPromise(
      Effect.provide(program, TestLayers) as Effect.Effect<void>,
    )
  })

  for (const ambiguity of [false, true]) {
    it(`recovers ordinary external flow dispatch after ${ambiguity ? "an accepted response is lost" : "a post-commit enqueue failure"}`, async () => {
      let executions = 0
      const { org } = makeTestOrg(
        Effect.sync(() => {
          executions += 1
          return { completed: true }
        }),
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
          const { todoId, stepPath } = yield* insertExecutionWithSystemTodo
          const now = yield* DateTime.now
          const job: Job<{ todoId: string; stepPath: string }> = {
            jobId: "job-external-ordinary",
            queue: SYSTEM_STEP_EXECUTION_QUEUE,
            payload: { todoId, stepPath },
            attempts: 5,
            maxAttempts: 5,
            availableAt: now,
            lockedUntil: now,
          }

          const first = yield* systemStepExecutionHandler
            .handle(job)
            .pipe(Effect.either)
          expect(first._tag).toBe("Left")

          const db = yield* TypedSqliteDrizzle
          const scheduledBeforeRetry = yield* db
            .select({ id: schema.scheduledFlow.id })
            .from(schema.scheduledFlow)
          const outboxBeforeRetry = yield* db
            .select({ payload: schema.jobQueue.jobPayload })
            .from(schema.jobQueue)
          expect(scheduledBeforeRetry).toHaveLength(1)
          expect(outboxBeforeRetry).toHaveLength(1)

          const flowExecutionOps = yield* FlowExecutionOperations
          expect(
            yield* flowExecutionOps.countPendingFlowJobs(
              "pex-test-system-001",
              FLOW_EXECUTION_QUEUE,
            ),
          ).toBe(1)

          const executionBeforeDispatch = yield* db
            .select({ finishedAt: schema.processExecution.finishedAt })
            .from(schema.processExecution)
            .where(eq(schema.processExecution.id, "pex-test-system-001"))
          expect(executionBeforeDispatch[0]?.finishedAt).toBeNull()

          if (ambiguity) {
            const acceptedFlowJob = enqueuedJobs.find(
              (queuedJob) => queuedJob.queue === FLOW_EXECUTION_QUEUE,
            )
            if (!acceptedFlowJob?.logicalJobId) {
              throw new Error("Expected accepted flow job")
            }
            yield* flowExecutionHandler.handle({
              jobId: acceptedFlowJob.logicalJobId,
              queue: FLOW_EXECUTION_QUEUE,
              payload: acceptedFlowJob.payload as {
                scheduledFlowId: string
              },
              attempts: 1,
              maxAttempts: 5,
              availableAt: now,
              lockedUntil: now,
            })

            const executionAfterClaim = yield* db
              .select({ finishedAt: schema.processExecution.finishedAt })
              .from(schema.processExecution)
              .where(eq(schema.processExecution.id, "pex-test-system-001"))
            expect(executionAfterClaim[0]?.finishedAt).not.toBeNull()
          }

          yield* systemStepExecutionHandler.handle({
            ...job,
            attempts: 6,
          })

          expect(executions).toBe(1)
          expect(
            yield* db.select({ id: schema.jobQueue.id }).from(schema.jobQueue),
          ).toEqual([])
          expect(
            yield* db
              .select({ id: schema.scheduledFlow.id })
              .from(schema.scheduledFlow),
          ).toEqual(ambiguity ? [] : scheduledBeforeRetry)
        }).pipe(Effect.provide(layers)) as Effect.Effect<void>,
      )

      const physicalFlowJobs = enqueuedJobs.filter(
        (job) => job.queue === FLOW_EXECUTION_QUEUE,
      )
      expect(physicalFlowJobs).toHaveLength(ambiguity ? 2 : 1)
      expect(
        new Set(physicalFlowJobs.map((job) => job.logicalJobId)).size,
      ).toBe(1)
      expect(
        new Set(
          physicalFlowJobs.map((job) =>
            JSON.stringify(
              (job.payload as { scheduledFlowId: string }).scheduledFlowId,
            ),
          ),
        ).size,
      ).toBe(1)
    })
  }

  it("recovers terminal onError flow dispatch without repeating failure state", async () => {
    let executions = 0
    const { org } = makeOnErrorTestOrg(
      Effect.sync(() => {
        executions += 1
        throw Object.assign(new Error("terminal"), { _tag: "Retryable" })
      }),
    )
    const { layers, enqueuedJobs } = createTestLayers(org, {
      queueInTransaction: false,
      failEnqueueAttempts: [1],
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* storeOrganisation(org)
        const { todoId, stepPath } = yield* insertExecutionWithSystemTodo
        const now = yield* DateTime.now
        const job: Job<{ todoId: string; stepPath: string }> = {
          jobId: "job-external-on-error",
          queue: SYSTEM_STEP_EXECUTION_QUEUE,
          payload: { todoId, stepPath },
          attempts: 5,
          maxAttempts: 5,
          availableAt: now,
          lockedUntil: now,
        }

        expect(
          (yield* systemStepExecutionHandler.handle(job).pipe(Effect.either))
            ._tag,
        ).toBe("Left")
        yield* systemStepExecutionHandler.handle({ ...job, attempts: 6 })

        const db = yield* TypedSqliteDrizzle
        const todos = yield* db
          .select({ failureReason: schema.toDo.failureReason })
          .from(schema.toDo)
          .where(eq(schema.toDo.id, todoId))
        expect(todos[0]?.failureReason).toContain("terminal")
        expect(
          yield* db.select({ id: schema.jobQueue.id }).from(schema.jobQueue),
        ).toEqual([])
        expect(
          yield* db
            .select({ id: schema.scheduledFlow.id })
            .from(schema.scheduledFlow),
        ).toHaveLength(1)
      }).pipe(Effect.provide(layers)) as Effect.Effect<void>,
    )

    expect(executions).toBe(1)
    expect(enqueuedJobs).toEqual([
      expect.objectContaining({
        queue: FLOW_EXECUTION_QUEUE,
        logicalJobId: expect.stringMatching(/^flow-execution:/),
        payload: expect.objectContaining({
          onError: true,
          errorTag: "Retryable",
        }),
      }),
    ])
  })

  it("recovers started-step external flow dispatch before its completed marker", async () => {
    let executions = 0
    const { org } = makeStartSystemStepOrg(
      Effect.sync(() => {
        executions += 1
        return { greeting: "hello" }
      }),
    )
    const { layers, enqueuedJobs } = createTestLayers(org, {
      queueInTransaction: false,
      failEnqueueAttempts: [1],
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* storeOrganisation(org)
        const { processExecutionId, stepId, stepPath } =
          yield* insertExecutionForStartSystemStep
        const now = yield* DateTime.now
        const job: Job<{
          startsProcess: true
          processExecutionId: string
          stepId: string
          stepPath: string
        }> = {
          jobId: "physical-start-job",
          queue: SYSTEM_STEP_EXECUTION_QUEUE,
          payload: {
            startsProcess: true,
            processExecutionId,
            stepId,
            stepPath,
          },
          attempts: 5,
          maxAttempts: 5,
          availableAt: now,
          lockedUntil: now,
        }

        expect(
          (yield* systemStepExecutionHandler.handle(job).pipe(Effect.either))
            ._tag,
        ).toBe("Left")
        yield* systemStepExecutionHandler.handle({ ...job, attempts: 6 })

        const db = yield* TypedSqliteDrizzle
        expect(
          yield* db.select({ id: schema.jobQueue.id }).from(schema.jobQueue),
        ).toEqual([])
        expect(
          yield* db
            .select({ id: schema.scheduledFlow.id })
            .from(schema.scheduledFlow),
        ).toHaveLength(1)
      }).pipe(Effect.provide(layers)) as Effect.Effect<void>,
    )

    expect(executions).toBe(1)
    expect(enqueuedJobs).toEqual([
      expect.objectContaining({
        queue: FLOW_EXECUTION_QUEUE,
        logicalJobId: expect.stringMatching(/^flow-execution:/),
      }),
    ])
  })

  it("recovers async completion flow dispatch before the duplicate callback check", async () => {
    const { org } = makeTestOrg(Effect.succeed({}))
    const { layers, enqueuedJobs } = createTestLayers(org, {
      queueInTransaction: false,
      failEnqueueAttempts: [1],
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* storeOrganisation(org)
        const { todoId, stepPath } = yield* insertExecutionWithSystemTodo
        const todoInfo = yield* loadTodoInfo(todoId)
        const queueService = yield* QueueService
        const stepCompletionOps = yield* StepCompletionOperations
        const scheduledFlowOps = yield* ScheduledFlowOperations
        const flowExecutionOps = yield* FlowExecutionOperations
        const calendarQueries = yield* BusinessCalendarQueries
        const sqlClient = yield* SqlClient.SqlClient
        const complete = () =>
          completeAsyncSystemStep({
            todoId,
            stepPath,
            output: { emailId: "email-1" },
            todoInfo,
            isForEach: false,
            queueService,
            stepCompletionOps,
            scheduledFlowOps,
            flowExecutionOps,
            calendarQueries,
            sqlClient,
          })

        expect((yield* complete().pipe(Effect.either))._tag).toBe("Left")
        expect(yield* complete()).toBe(true)

        const db = yield* TypedSqliteDrizzle
        expect(
          yield* db.select({ id: schema.jobQueue.id }).from(schema.jobQueue),
        ).toEqual([])
        expect(
          yield* db
            .select({ id: schema.scheduledFlow.id })
            .from(schema.scheduledFlow),
        ).toHaveLength(1)
      }).pipe(Effect.provide(layers)) as Effect.Effect<void>,
    )

    expect(enqueuedJobs).toEqual([
      expect.objectContaining({
        queue: FLOW_EXECUTION_QUEUE,
        logicalJobId: expect.stringMatching(/^flow-execution:/),
      }),
    ])
  })

  it("recovers async failure flow dispatch before the inactive-todo check", async () => {
    const { org } = makeCatchAllOnErrorTestOrg(Effect.succeed({}))
    const { layers, enqueuedJobs } = createTestLayers(org, {
      queueInTransaction: false,
      failEnqueueAttempts: [1],
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* storeOrganisation(org)
        const { todoId } = yield* insertExecutionWithSystemTodo
        const todoInfo = yield* loadTodoInfo(todoId)
        const queueService = yield* QueueService
        const stepCompletionOps = yield* StepCompletionOperations
        const scheduledFlowOps = yield* ScheduledFlowOperations
        const flowExecutionOps = yield* FlowExecutionOperations
        const sqlClient = yield* SqlClient.SqlClient
        const fail = () =>
          failAsyncSystemStep({
            todoId,
            processExecutionId: todoInfo.processExecutionId,
            failureReason: "async terminal failure",
            queueService,
            stepCompletionOps,
            scheduledFlowOps,
            flowExecutionOps,
            sqlClient,
          })

        expect((yield* fail().pipe(Effect.either))._tag).toBe("Left")
        const recovered = yield* fail()
        expect(recovered.didFail).toBe(true)

        const db = yield* TypedSqliteDrizzle
        expect(
          yield* db.select({ id: schema.jobQueue.id }).from(schema.jobQueue),
        ).toEqual([])
        expect(
          yield* db
            .select({ id: schema.scheduledFlow.id })
            .from(schema.scheduledFlow),
        ).toHaveLength(1)
      }).pipe(Effect.provide(layers)) as Effect.Effect<void>,
    )

    expect(enqueuedJobs).toEqual([
      expect.objectContaining({
        queue: FLOW_EXECUTION_QUEUE,
        logicalJobId: expect.stringMatching(/^flow-execution:/),
        payload: expect.objectContaining({ onError: true }),
      }),
    ])
  })
})
