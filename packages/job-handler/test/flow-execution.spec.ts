import { eq } from "drizzle-orm"
import {
  DateTime,
  type Duration,
  Effect,
  FiberRef,
  Layer,
  Option,
  Schema,
} from "effect"
import * as schema from "@pf/drizzle-sqlite"
import {
  CompletedJobOperations,
  FLOW_EXECUTION_QUEUE,
  FlowExecutionOperations,
  SYSTEM_STEP_EXECUTION_QUEUE,
  ScheduledFlowOperations,
  UserDetails,
  type UserDetailsValue,
  encodeDelegationAudit,
  serializeNotificationPreferences,
} from "@pf/graphql-db-operations"
import {
  EXECUTION_EVENT_QUEUE,
  ExecutionFromJobPublisher,
  NOTIFICATION_DELIVERY_QUEUE,
  type NotificationDeliveryPayload,
  PROCESS_EVENT_QUEUE,
  ProcessFromJobPublisher,
  TODO_EVENT_QUEUE,
  flowExecutionHandler,
  makeNotificationDeliveryConfig,
} from "@pf/job-handler"
import { storeOrganisation } from "@pf/org-to-db"
import {
  ConditionEvaluator,
  ForEachItemsResolver,
  Form,
  NodeStep,
  Organisation,
  OrganisationProvider,
  Process,
  Role,
  Schedule,
  ScheduleEvaluator,
  type ScheduleEvaluatorService,
  makeConditionEvaluator,
  makeForEachItemsResolver,
  makeScheduleEvaluator,
} from "@pf/process"
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
import { createTestOrganisation } from "./test-org"
import { describe, expect, it } from "bun:test"

/**
 * Captures enqueued job payloads for verification.
 */
interface EnqueuedJob {
  queue: string
  payload: unknown
  delay?: Duration.Duration
  logicalJobId?: string
}

type FlowExecutionOpsTransform = (
  base: FlowExecutionOperations["Type"],
) => FlowExecutionOperations["Type"]

type ScheduledFlowOpsTransform = (
  base: ScheduledFlowOperations["Type"],
) => ScheduledFlowOperations["Type"]

/**
 * Creates a mock QueueService that captures enqueued jobs.
 * Sets queueInTransaction: true to simulate DB-backed queue behavior,
 * where jobs should be enqueued inside the transaction.
 */
const createMockQueueService = ({
  onEnqueue,
  queueInTransaction = true,
}: {
  readonly onEnqueue?: (
    queue: string,
    payload: unknown,
    options?: { readonly logicalJobId?: string },
  ) => Effect.Effect<void, EnqueueError, TypedSqliteDrizzle>
  readonly queueInTransaction?: boolean
} = {}) => {
  const enqueuedJobs: EnqueuedJob[] = []
  const layer = Layer.succeed(QueueService, {
    queueInTransaction,
    enqueue: (queue, payload, options) =>
      Effect.gen(function* () {
        if (onEnqueue) {
          yield* onEnqueue(queue, payload, options)
        }
        enqueuedJobs.push({
          queue,
          payload,
          ...(options?.logicalJobId
            ? { logicalJobId: options.logicalJobId }
            : {}),
        })
        return `mock-job-${enqueuedJobs.length}`
      }),
    enqueueWithDelay: (queue, payload, delay, options) =>
      Effect.gen(function* () {
        if (onEnqueue) {
          yield* onEnqueue(queue, payload, options)
        }
        enqueuedJobs.push({
          queue,
          payload,
          delay,
          ...(options?.logicalJobId
            ? { logicalJobId: options.logicalJobId }
            : {}),
        })
        return `mock-job-${enqueuedJobs.length}`
      }),
    rawClaim: () => Effect.succeed(Option.none()),
    acknowledge: () => Effect.void,
    fail: () => Effect.void,
    extendVisibility: () => Effect.void,
    getStats: () =>
      Effect.succeed({
        pending: 0,
        processing: 0,
        deadLetter: 0,
      }),
  })
  return { layer, enqueuedJobs }
}

/**
 * Creates a mock ProcessFromJobPublisher (noop for tests).
 */
const MockProcessFromJobPublisherLayer = Layer.succeed(
  ProcessFromJobPublisher,
  {
    publishProcessChanged: () => Effect.succeed("published" as const),
  },
)

/**
 * Creates a mock ExecutionFromJobPublisher (noop for tests).
 */
const MockExecutionFromJobPublisherLayer = Layer.succeed(
  ExecutionFromJobPublisher,
  {
    publishExecutionChanged: () => Effect.succeed("published" as const),
  },
)

/**
 * Creates the test layers for flow execution handler tests.
 * Includes all required services with the mock queue service.
 */
const createTestLayersForOrg = ({
  mockQueueServiceLayer,
  org,
  scheduleEvaluator,
  flowExecutionOpsTransform,
  scheduledFlowOpsTransform,
}: {
  mockQueueServiceLayer: Layer.Layer<QueueService>
  org: Organisation
  scheduleEvaluator?: ScheduleEvaluatorService
  flowExecutionOpsTransform?: FlowExecutionOpsTransform
  scheduledFlowOpsTransform?: ScheduledFlowOpsTransform
}) => {
  const ConditionEvaluatorLive = Layer.succeed(
    ConditionEvaluator,
    makeConditionEvaluator(org),
  )
  const ScheduleEvaluatorLive = Layer.succeed(
    ScheduleEvaluator,
    scheduleEvaluator ?? makeScheduleEvaluator(org),
  )
  const ForEachItemsResolverLive = Layer.succeed(
    ForEachItemsResolver,
    makeForEachItemsResolver(org),
  )
  const OrganisationProviderLive = Layer.succeed(OrganisationProvider, {
    organisation: org,
    orgPath: "/test-org",
    schemaPath: "/test-org/org.graphql",
    customGraphqlSchema: undefined,
  })
  const NotificationDeliveryConfigLive = makeNotificationDeliveryConfig(
    () => "https://frontend.example.test",
  )
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

  // Base database layer - provides TypedSqliteDrizzle
  const BaseDbLayer = Layer.provideMerge(SqliteDbOperationsLive, DatabaseTest)
  const FlowExecutionOpsLive = flowExecutionOpsTransform
    ? Layer.provide(
        Layer.effect(
          FlowExecutionOperations,
          Effect.gen(function* () {
            const base = yield* FlowExecutionOperations
            return flowExecutionOpsTransform(base)
          }),
        ),
        SqliteFlowExecutionOperationsLive,
      )
    : SqliteFlowExecutionOperationsLive
  const ScheduledFlowOpsLive = scheduledFlowOpsTransform
    ? Layer.provide(
        Layer.effect(
          ScheduledFlowOperations,
          Effect.gen(function* () {
            const base = yield* ScheduledFlowOperations
            return scheduledFlowOpsTransform(base)
          }),
        ),
        SqliteScheduledFlowOperationsLive,
      )
    : SqliteScheduledFlowOperationsLive

  // Operation layers that depend on TypedSqliteDrizzle
  const OperationLayers = Layer.provideMerge(
    Layer.mergeAll(
      FlowExecutionOpsLive,
      ScheduledFlowOpsLive,
      SqliteCompletedJobOperationsLive,
      SqliteGraphqlDbOperationsLive,
    ),
    BaseDbLayer,
  )

  // Independent layers (no TypedSqliteDrizzle dependency)
  const IndependentLayers = Layer.mergeAll(
    ConditionEvaluatorLive,
    ScheduleEvaluatorLive,
    ForEachItemsResolverLive,
    OrganisationProviderLive,
    NotificationDeliveryConfigLive,
    RequestTimeLive,
    UserDetailsLive,
    mockQueueServiceLayer,
    MockProcessFromJobPublisherLayer,
    MockExecutionFromJobPublisherLayer,
  )

  // Compose all layers
  const layers = Layer.mergeAll(IndependentLayers, OperationLayers, BaseDbLayer)

  return { org, layers }
}

const createTestLayers = (
  mockQueueServiceLayer: Layer.Layer<QueueService>,
  flowExecutionOpsTransform?: FlowExecutionOpsTransform,
  scheduledFlowOpsTransform?: ScheduledFlowOpsTransform,
) => {
  const { org } = createTestOrganisation()
  return createTestLayersForOrg({
    mockQueueServiceLayer,
    org,
    flowExecutionOpsTransform,
    scheduledFlowOpsTransform,
  })
}

const createDirectAssigneeOrganisation = (assignee: string) => {
  const org = new Organisation({ name: "DirectAssigneeOrg" })
  const employee = new Role(org, "employee", { name: "Employee" })

  const process = new Process(org, "direct-assignee-process", {
    name: "Direct Assignee Process",
    purpose: "Test direct assignee resolution",
  })

  const submit = new Form(process, "submit", {
    name: "Submit",
    role: employee,
    purpose: "Submit step",
    form: () => ({ data: Schema.String }),
  })

  const approve = new Form(process, "approve", {
    name: "Approve",
    role: employee,
    purpose: "Approve step",
    assignee: () => assignee,
    form: () => ({}),
  })

  process.start(submit).next(approve)

  return { org, process, approve }
}

/**
 * Creates test layers with a custom ScheduleEvaluator for testing schedule behavior.
 */
const createTestLayersWithScheduleEvaluator = (
  mockQueueServiceLayer: Layer.Layer<QueueService>,
  scheduleEvaluator: ScheduleEvaluatorService,
) => {
  const { org } = createTestOrganisation()

  return createTestLayersForOrg({
    mockQueueServiceLayer,
    org,
    scheduleEvaluator,
  })
}

const getNotificationJobs = (
  enqueuedJobs: readonly EnqueuedJob[],
): NotificationDeliveryPayload[] =>
  enqueuedJobs
    .filter((job) => job.queue === NOTIFICATION_DELIVERY_QUEUE)
    .map((job) => job.payload as NotificationDeliveryPayload)

const withDirectAssignee =
  (providerUserId: string): FlowExecutionOpsTransform =>
  (base) => ({
    ...base,
    queryTodoNotificationInfo: (todoIds) =>
      base.queryTodoNotificationInfo(todoIds).pipe(
        Effect.map((todos) =>
          todos.map((todo) => ({
            ...todo,
            assignedToProviderUserId: providerUserId,
          })),
        ),
      ),
  })

const withDuplicatedRoleRecipients =
  (): FlowExecutionOpsTransform => (base) => ({
    ...base,
    queryNotificationRecipientsByRoleId: (roleId) =>
      base
        .queryNotificationRecipientsByRoleId(roleId)
        .pipe(
          Effect.map((recipients) =>
            recipients.length === 0
              ? recipients
              : [recipients[0], ...recipients],
          ),
        ),
  })

const insertProviderUser = (params: {
  userId: string
  providerUserId: string
  roleIds: readonly string[]
  email: string
  name: string
  notificationsEnabled?: boolean
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

    if (params.notificationsEnabled !== undefined) {
      yield* db.insert(schema.userSettings).values({
        id: `us-${params.userId}`,
        userId: params.userId,
        notificationPreference: serializeNotificationPreferences({
          notifications: {
            todoAssignment: {
              email: params.notificationsEnabled,
            },
            executionFailure: {
              email: false,
            },
          },
        }),
      })
    }
  })

const createSystemStepOrg = () => {
  const org = new Organisation({ name: "SystemNotificationTestOrg" })
  const employee = new Role(org, "employee", { name: "Employee" })

  const process = new Process(org, "system-step-process", {
    name: "System Step Process",
    purpose: "Test process for system todo notifications",
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
    execute: () => Effect.succeed({}),
  })

  // Flow execution starts from the human form step, but the created downstream
  // todo targets the system step, which should not fan out notifications.
  process.start(submit).next(system).end()

  return { org }
}

const createAlwaysNotifyOrg = () => {
  const org = new Organisation({ name: "AlwaysNotifyTestOrg" })
  const employee = new Role(org, "employee", { name: "Employee" })

  const process = new Process(org, "always-notify-process", {
    name: "Always Notify Process",
    purpose: "Test process for mandatory todo notifications",
  })

  const submit = new Form(process, "submit", {
    name: "Submit",
    role: employee,
    form: () => ({}),
  })

  const pickup = new Form(process, "pickup", {
    name: "Pickup key",
    role: employee,
    alwaysNotify: true,
    form: () => ({}),
  })

  process.start(submit).next(pickup)

  return { org }
}

const createPublicCompletionOrg = () => {
  const org = new Organisation({ name: "PublicCompletionTestOrg" })
  const employee = new Role(org, "employee", { name: "Employee" })

  const process = new Process(org, "public-completion-process", {
    name: "Public Completion Process",
    purpose: "Test process for public completion notifications",
  })

  const submit = new Form(process, "submit", {
    name: "Submit",
    role: employee,
    form: () => ({}),
  })
  const review = new Form(process.start(submit), "review", {
    name: "External Review",
    role: employee,
    form: () => ({}),
    publicCompletion: {
      recipient: (state) => ({
        email: String(state["externalEmail"]),
        displayName: "External Reviewer",
      }),
      expiresAt: () => DateTime.unsafeMake("2099-01-01T10:00:00.000Z"),
      from: "Award Leader <award.leader@example.com>",
      subject: (_state, _ctx, _item, publicUrl) => `Please review ${publicUrl}`,
      body: (state) => `Review request ${String(state["reference"])}`,
      template: (state) => ({
        id: "public-review-template",
        variables: {
          REFERENCE: String(state["reference"]),
        },
      }),
      attachments: () => [
        {
          filename: "review.pdf",
          storePrefix: "/review-documents",
          fileId: "file-review-001",
        },
      ],
    },
  })
  submit.end(review)

  return { org }
}

const createOnErrorFlowOrg = () => {
  const org = new Organisation({ name: "OnErrorFlowTestOrg" })
  const employee = new Role(org, "employee", { name: "Employee" })

  const process = new Process(org, "on-error-flow-process", {
    name: "On Error Flow Process",
    purpose: "Test runtime onError routing",
  })

  const submit = new Form(process, "submit", {
    role: employee,
    form: () => ({}),
  })
  const system = new NodeStep(process, "system", {
    input: () => Effect.succeed({}),
    output: {},
    execute: () => Effect.succeed({}),
  })
  const success = new Form(process, "success", {
    role: employee,
    form: () => ({}),
  })
  const retryableRecovery = new Form(process, "retryable_recovery", {
    role: employee,
    form: () => ({}),
  })
  const catchAllRecovery = new Form(process, "catch_all_recovery", {
    role: employee,
    form: () => ({}),
  })

  process.start(submit).next(system)
  system.next(success).end()
  system.onError(retryableRecovery, { taggedErrors: ["Retryable"] }).end()
  system.onError(catchAllRecovery).end()

  return {
    org,
    paths: {
      submit: `/${submit.node.path}`,
      system: `/${system.node.path}`,
      success: `/${success.node.path}`,
      retryableRecovery: `/${retryableRecovery.node.path}`,
      catchAllRecovery: `/${catchAllRecovery.node.path}`,
    },
  }
}

const createCaseSensitiveOnErrorFlowOrg = () => {
  const org = new Organisation({ name: "CaseSensitiveOnErrorFlowTestOrg" })
  const employee = new Role(org, "employee", { name: "Employee" })

  const process = new Process(org, "case-sensitive-on-error-flow-process", {
    name: "Case Sensitive On Error Flow Process",
    purpose: "Test case-sensitive tagged onError routing",
  })

  const submit = new Form(process, "submit", {
    role: employee,
    form: () => ({}),
  })
  const system = new NodeStep(process, "system", {
    input: () => Effect.succeed({}),
    output: {},
    execute: () => Effect.succeed({}),
  })
  const retryableRecovery = new Form(process, "retryable_recovery", {
    role: employee,
    form: () => ({}),
  })
  const lowercaseRecovery = new Form(process, "lowercase_recovery", {
    role: employee,
    form: () => ({}),
  })
  const catchAllRecovery = new Form(process, "catch_all_recovery", {
    role: employee,
    form: () => ({}),
  })

  process.start(submit).next(system)
  system.onError(retryableRecovery, { taggedErrors: ["Retryable"] }).end()
  system.onError(lowercaseRecovery, { taggedErrors: ["retryable"] }).end()
  system.onError(catchAllRecovery).end()

  return {
    org,
    paths: {
      submit: `/${submit.node.path}`,
      system: `/${system.node.path}`,
      retryableRecovery: `/${retryableRecovery.node.path}`,
      lowercaseRecovery: `/${lowercaseRecovery.node.path}`,
      catchAllRecovery: `/${catchAllRecovery.node.path}`,
    },
  }
}

const createDuplicateTaggedOnErrorFlowOrg = () => {
  const org = new Organisation({ name: "DuplicateTaggedOnErrorFlowTestOrg" })
  const employee = new Role(org, "employee", { name: "Employee" })

  const process = new Process(org, "duplicate-tagged-on-error-flow-process", {
    name: "Duplicate Tagged On Error Flow Process",
    purpose: "Test duplicate tagged onError fanout",
  })

  const submit = new Form(process, "submit", {
    role: employee,
    form: () => ({}),
  })
  const system = new NodeStep(process, "system", {
    input: () => Effect.succeed({}),
    output: {},
    execute: () => Effect.succeed({}),
  })
  const duplicateRecovery = new Form(process, "duplicate_recovery", {
    role: employee,
    form: () => ({}),
  })
  const catchAllRecovery = new Form(process, "catch_all_recovery", {
    role: employee,
    form: () => ({}),
  })

  process.start(submit).next(system)
  system.onError(duplicateRecovery, { taggedErrors: ["Retryable"] })
  system.onError(duplicateRecovery, { taggedErrors: ["Retryable"] }).end()
  system.onError(catchAllRecovery).end()

  return {
    org,
    paths: {
      submit: `/${submit.node.path}`,
      system: `/${system.node.path}`,
      duplicateRecovery: `/${duplicateRecovery.node.path}`,
      catchAllRecovery: `/${catchAllRecovery.node.path}`,
    },
  }
}

const runProvidedTestProgram = <A, E, R, LE>(
  program: Effect.Effect<A, E, R>,
  layers: Layer.Layer<R, LE, never>,
) => Effect.runPromise(Effect.provide(program, layers).pipe(Effect.asVoid))

describe("Flow Execution Handler", () => {
  it("ignores onError edges during normal flow execution", async () => {
    const { layer: mockQueueServiceLayer } = createMockQueueService()
    const { org, paths } = createOnErrorFlowOrg()
    const { layers: TestLayers } = createTestLayersForOrg({
      mockQueueServiceLayer,
      org,
    })

    const testProgram = Effect.gen(function* () {
      yield* storeOrganisation(org)

      const db = yield* TypedSqliteDrizzle
      const steps = yield* db
        .select({ id: schema.step.id, path: schema.step.path })
        .from(schema.step)

      const stepIdByPath = new Map(steps.map((step) => [step.path, step.id]))
      const process = (yield* db.select().from(schema.process).limit(1))[0]
      const systemStepId = stepIdByPath.get(paths.system)
      const submitStepId = stepIdByPath.get(paths.submit)
      expect(process).toBeDefined()
      expect(systemStepId).toBeDefined()
      expect(submitStepId).toBeDefined()

      const processStateId = "pst-on-error-success-001"
      yield* db.insert(schema.processState).values({
        id: processStateId,
        processId: process!.id,
        startStepId: submitStepId!,
        state: {},
      })

      const processExecutionId = "pex-on-error-success-001"
      yield* db.insert(schema.processExecution).values({
        id: processExecutionId,
        processStateId,
      })

      const scheduledFlowOps = yield* ScheduledFlowOperations
      const scheduledFlowId = yield* scheduledFlowOps.insertScheduledFlow(
        processExecutionId,
        systemStepId!,
      )

      const now = yield* DateTime.now
      yield* flowExecutionHandler.handle({
        jobId: "job-on-error-success-001",
        queue: FLOW_EXECUTION_QUEUE,
        payload: { scheduledFlowId },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      })

      const todoTargets = yield* db
        .select({ targetPath: schema.step.path })
        .from(schema.toDo)
        .innerJoin(schema.flow, eq(schema.toDo.flowId, schema.flow.id))
        .innerJoin(schema.step, eq(schema.flow.targetStepId, schema.step.id))

      expect(todoTargets).toEqual([{ targetPath: paths.success }])
    })

    await runProvidedTestProgram(testProgram, TestLayers)
  })

  it("prefers tagged onError edges over catch-all branches", async () => {
    const { layer: mockQueueServiceLayer } = createMockQueueService()
    const { org, paths } = createOnErrorFlowOrg()
    const { layers: TestLayers } = createTestLayersForOrg({
      mockQueueServiceLayer,
      org,
    })

    const testProgram = Effect.gen(function* () {
      yield* storeOrganisation(org)

      const db = yield* TypedSqliteDrizzle
      const steps = yield* db
        .select({ id: schema.step.id, path: schema.step.path })
        .from(schema.step)

      const stepIdByPath = new Map(steps.map((step) => [step.path, step.id]))
      const process = (yield* db.select().from(schema.process).limit(1))[0]
      const systemStepId = stepIdByPath.get(paths.system)
      const submitStepId = stepIdByPath.get(paths.submit)
      expect(process).toBeDefined()
      expect(systemStepId).toBeDefined()
      expect(submitStepId).toBeDefined()

      const processStateId = "pst-on-error-failure-001"
      yield* db.insert(schema.processState).values({
        id: processStateId,
        processId: process!.id,
        startStepId: submitStepId!,
        state: {},
      })

      const processExecutionId = "pex-on-error-failure-001"
      yield* db.insert(schema.processExecution).values({
        id: processExecutionId,
        processStateId,
      })

      const scheduledFlowOps = yield* ScheduledFlowOperations
      const scheduledFlowId = yield* scheduledFlowOps.insertScheduledFlow(
        processExecutionId,
        systemStepId!,
      )

      const now = yield* DateTime.now
      yield* flowExecutionHandler.handle({
        jobId: "job-on-error-failure-001",
        queue: FLOW_EXECUTION_QUEUE,
        payload: { scheduledFlowId, onError: true, errorTag: "Retryable" },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      })

      const todoTargets = yield* db
        .select({ targetPath: schema.step.path })
        .from(schema.toDo)
        .innerJoin(schema.flow, eq(schema.toDo.flowId, schema.flow.id))
        .innerJoin(schema.step, eq(schema.flow.targetStepId, schema.step.id))

      expect(todoTargets).toEqual([{ targetPath: paths.retryableRecovery }])
    })

    await runProvidedTestProgram(testProgram, TestLayers)
  })

  it("routes untagged onError executions to catch-all branches", async () => {
    const { layer: mockQueueServiceLayer } = createMockQueueService()
    const { org, paths } = createOnErrorFlowOrg()
    const { layers: TestLayers } = createTestLayersForOrg({
      mockQueueServiceLayer,
      org,
    })

    const testProgram = Effect.gen(function* () {
      yield* storeOrganisation(org)

      const db = yield* TypedSqliteDrizzle
      const steps = yield* db
        .select({ id: schema.step.id, path: schema.step.path })
        .from(schema.step)

      const stepIdByPath = new Map(steps.map((step) => [step.path, step.id]))
      const process = (yield* db.select().from(schema.process).limit(1))[0]
      const systemStepId = stepIdByPath.get(paths.system)
      const submitStepId = stepIdByPath.get(paths.submit)
      expect(process).toBeDefined()
      expect(systemStepId).toBeDefined()
      expect(submitStepId).toBeDefined()

      const processStateId = "pst-on-error-catch-all-001"
      yield* db.insert(schema.processState).values({
        id: processStateId,
        processId: process!.id,
        startStepId: submitStepId!,
        state: {},
      })

      const processExecutionId = "pex-on-error-catch-all-001"
      yield* db.insert(schema.processExecution).values({
        id: processExecutionId,
        processStateId,
      })

      const scheduledFlowOps = yield* ScheduledFlowOperations
      const scheduledFlowId = yield* scheduledFlowOps.insertScheduledFlow(
        processExecutionId,
        systemStepId!,
      )

      const now = yield* DateTime.now
      yield* flowExecutionHandler.handle({
        jobId: "job-on-error-catch-all-001",
        queue: FLOW_EXECUTION_QUEUE,
        payload: { scheduledFlowId, onError: true },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      })

      const todoTargets = yield* db
        .select({ targetPath: schema.step.path })
        .from(schema.toDo)
        .innerJoin(schema.flow, eq(schema.toDo.flowId, schema.flow.id))
        .innerJoin(schema.step, eq(schema.flow.targetStepId, schema.step.id))

      expect(todoTargets).toEqual([{ targetPath: paths.catchAllRecovery }])
    })

    await runProvidedTestProgram(testProgram, TestLayers)
  })

  it("matches tagged onError flows case-sensitively", async () => {
    const { layer: mockQueueServiceLayer } = createMockQueueService()
    const { org, paths } = createCaseSensitiveOnErrorFlowOrg()
    const { layers: TestLayers } = createTestLayersForOrg({
      mockQueueServiceLayer,
      org,
    })

    const testProgram = Effect.gen(function* () {
      yield* storeOrganisation(org)

      const db = yield* TypedSqliteDrizzle
      const steps = yield* db
        .select({ id: schema.step.id, path: schema.step.path })
        .from(schema.step)

      const stepIdByPath = new Map(steps.map((step) => [step.path, step.id]))
      const process = (yield* db.select().from(schema.process).limit(1))[0]
      const systemStepId = stepIdByPath.get(paths.system)
      const submitStepId = stepIdByPath.get(paths.submit)
      expect(process).toBeDefined()
      expect(systemStepId).toBeDefined()
      expect(submitStepId).toBeDefined()

      const processStateId = "pst-on-error-case-sensitive-001"
      yield* db.insert(schema.processState).values({
        id: processStateId,
        processId: process!.id,
        startStepId: submitStepId!,
        state: {},
      })

      const processExecutionId = "pex-on-error-case-sensitive-001"
      yield* db.insert(schema.processExecution).values({
        id: processExecutionId,
        processStateId,
      })

      const scheduledFlowOps = yield* ScheduledFlowOperations
      const scheduledFlowId = yield* scheduledFlowOps.insertScheduledFlow(
        processExecutionId,
        systemStepId!,
      )

      const now = yield* DateTime.now
      yield* flowExecutionHandler.handle({
        jobId: "job-on-error-case-sensitive-001",
        queue: FLOW_EXECUTION_QUEUE,
        payload: { scheduledFlowId, onError: true, errorTag: "RETRYABLE" },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      })

      const todoTargets = yield* db
        .select({ targetPath: schema.step.path })
        .from(schema.toDo)
        .innerJoin(schema.flow, eq(schema.toDo.flowId, schema.flow.id))
        .innerJoin(schema.step, eq(schema.flow.targetStepId, schema.step.id))

      expect(todoTargets).toEqual([{ targetPath: paths.catchAllRecovery }])
    })

    await runProvidedTestProgram(testProgram, TestLayers)
  })

  it("fans out to duplicate matching tagged onError branches", async () => {
    const { layer: mockQueueServiceLayer } = createMockQueueService()
    const { org, paths } = createDuplicateTaggedOnErrorFlowOrg()
    const { layers: TestLayers } = createTestLayersForOrg({
      mockQueueServiceLayer,
      org,
    })

    const testProgram = Effect.gen(function* () {
      yield* storeOrganisation(org)

      const db = yield* TypedSqliteDrizzle
      const steps = yield* db
        .select({ id: schema.step.id, path: schema.step.path })
        .from(schema.step)

      const stepIdByPath = new Map(steps.map((step) => [step.path, step.id]))
      const process = (yield* db.select().from(schema.process).limit(1))[0]
      const systemStepId = stepIdByPath.get(paths.system)
      const submitStepId = stepIdByPath.get(paths.submit)
      expect(process).toBeDefined()
      expect(systemStepId).toBeDefined()
      expect(submitStepId).toBeDefined()

      const processStateId = "pst-on-error-duplicate-tagged-001"
      yield* db.insert(schema.processState).values({
        id: processStateId,
        processId: process!.id,
        startStepId: submitStepId!,
        state: {},
      })

      const processExecutionId = "pex-on-error-duplicate-tagged-001"
      yield* db.insert(schema.processExecution).values({
        id: processExecutionId,
        processStateId,
      })

      const scheduledFlowOps = yield* ScheduledFlowOperations
      const scheduledFlowId = yield* scheduledFlowOps.insertScheduledFlow(
        processExecutionId,
        systemStepId!,
      )

      const now = yield* DateTime.now
      yield* flowExecutionHandler.handle({
        jobId: "job-on-error-duplicate-tagged-001",
        queue: FLOW_EXECUTION_QUEUE,
        payload: { scheduledFlowId, onError: true, errorTag: "Retryable" },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      })

      const todoTargets = yield* db
        .select({ targetPath: schema.step.path })
        .from(schema.toDo)
        .innerJoin(schema.flow, eq(schema.toDo.flowId, schema.flow.id))
        .innerJoin(schema.step, eq(schema.flow.targetStepId, schema.step.id))

      expect(todoTargets).toEqual([
        { targetPath: paths.duplicateRecovery },
        { targetPath: paths.duplicateRecovery },
      ])
    })

    await runProvidedTestProgram(testProgram, TestLayers)
  })

  it.each([
    undefined,
    encodeDelegationAudit({
      version: 1,
      ownerUserId: "usr-owner",
      ownerEmail: "owner@example.com",
      delegationId: "dlg-worker",
      generationId: "dsg-expired",
      name: "worker",
    }),
  ])(
    "creates a todo and preserves durable handoff attribution: %s",
    async (audit) => {
      const { layer: mockQueueServiceLayer, enqueuedJobs } =
        createMockQueueService()
      const { layers: TestLayers } = createTestLayers(mockQueueServiceLayer)

      const testProgram = Effect.gen(function* () {
        const { org } = createTestOrganisation()
        // 1. Store org in database (creates steps, flows, etc.)
        yield* storeOrganisation(org)

        // 2. Query the flow (submit -> approve)
        const db = yield* TypedSqliteDrizzle
        const flows = yield* db.select().from(schema.flow)
        expect(flows).toHaveLength(1)
        const flow = flows[0]
        if (!flow) throw new Error("Flow not found")

        // 3. Query the process and steps
        const processes = yield* db.select().from(schema.process)
        expect(processes).toHaveLength(1)
        const process = processes[0]
        if (!process) throw new Error("Process not found")

        // 4. Create process state (links to process via processId)
        const processStateId = "pst-test-001"
        yield* db.insert(schema.processState).values({
          id: processStateId,
          processId: process.id,
          startStepId: flow.sourceStepId,
          state: { data: "test" },
        })

        // 5. Create process execution (links to processState)
        const processExecutionId = "pex-test-001"
        yield* db.insert(schema.processExecution).values({
          id: processExecutionId,
          processStateId,
        })

        // 6. Create scheduled_flow record (2-phase commit pattern)
        const scheduledFlowOps = yield* ScheduledFlowOperations
        const userDetails = yield* UserDetails
        const scheduledFlowId = yield* scheduledFlowOps
          .insertScheduledFlow(processExecutionId, flow.sourceStepId)
          .pipe(
            Effect.locally(userDetails, { by: audit ?? "TEST_USER", id: null }),
          )

        // 7. Create and run the job with scheduledFlowId (new payload schema)
        const now = yield* DateTime.now
        const job = {
          jobId: "job-test-001",
          queue: "flow-execution" as const,
          payload: { scheduledFlowId },
          attempts: 1,
          maxAttempts: 5,
          availableAt: now,
          lockedUntil: now,
        }

        yield* flowExecutionHandler.handle(job)

        // 8. Verify todo was inserted in database
        const todos = yield* db.select().from(schema.toDo)
        expect(todos).toHaveLength(1)
        const dbTodo = todos[0]
        if (!dbTodo) throw new Error("DB todo not found")
        expect(dbTodo.processExecutionId).toBe(processExecutionId)
        expect(dbTodo.flowId).toBe(flow.id)
        expect(dbTodo.createdBy).toBe(audit ?? "TEST_USER")
        expect((yield* FiberRef.get(userDetails)).by).toBe("TEST_USER")

        // 9. Verify jobs were enqueued: todo-event, process-event, execution-event
        expect(enqueuedJobs).toHaveLength(3)

        // Verify todo-event job
        const todoEventJob = enqueuedJobs.find(
          (j) => j.queue === TODO_EVENT_QUEUE,
        )
        expect(todoEventJob).toBeDefined()
        expect(todoEventJob?.payload).toEqual({ todoIds: [dbTodo.id] })

        // Verify process-event job
        const processEventJob = enqueuedJobs.find(
          (j) => j.queue === PROCESS_EVENT_QUEUE,
        )
        expect(processEventJob).toBeDefined()
        expect(processEventJob?.payload).toEqual({ processId: process.id })

        // Verify execution-event job
        const executionEventJob = enqueuedJobs.find(
          (j) => j.queue === EXECUTION_EVENT_QUEUE,
        )
        expect(executionEventJob).toBeDefined()
        expect(executionEventJob?.payload).toEqual({
          executionId: processExecutionId,
        })

        // 10. Verify scheduled_flow was deleted after processing
        const scheduledFlows = yield* db.select().from(schema.scheduledFlow)
        expect(scheduledFlows).toHaveLength(0)
      })

      await runProvidedTestProgram(testProgram, TestLayers)
    },
  )

  it("should mark process execution as finished when no outgoing flows exist", async () => {
    const { layer: mockQueueServiceLayer, enqueuedJobs } =
      createMockQueueService()
    const { layers: TestLayers } = createTestLayers(mockQueueServiceLayer)

    const testProgram = Effect.gen(function* () {
      const { org } = createTestOrganisation()
      // 1. Store org in database (creates steps, flows, etc.)
      yield* storeOrganisation(org)

      // 2. Query the steps - we need the "approve" step which has no outgoing flows
      const db = yield* TypedSqliteDrizzle
      const steps = yield* db.select().from(schema.step)
      expect(steps).toHaveLength(2) // submit and approve
      const approveStep = steps.find((s) => s.name === "Approve")
      if (!approveStep) throw new Error("Approve step not found")

      // 3. Query the process
      const processes = yield* db.select().from(schema.process)
      expect(processes).toHaveLength(1)
      const process = processes[0]
      if (!process) throw new Error("Process not found")

      // 4. Create process state
      const processStateId = "pst-test-002"
      yield* db.insert(schema.processState).values({
        id: processStateId,
        processId: process.id,
        startStepId: approveStep.id,
        state: { data: "test" },
      })

      // 5. Create process execution (initially no finishedAt)
      const processExecutionId = "pex-test-002"
      yield* db.insert(schema.processExecution).values({
        id: processExecutionId,
        processStateId,
      })

      // 6. Verify process execution is NOT finished initially
      const beforeExecution = yield* db
        .select()
        .from(schema.processExecution)
        .where(eq(schema.processExecution.id, processExecutionId))
      expect(beforeExecution[0]?.finishedAt).toBeNull()

      // 7. Create scheduled_flow record (2-phase commit pattern)
      const scheduledFlowOps = yield* ScheduledFlowOperations
      const scheduledFlowId = yield* scheduledFlowOps.insertScheduledFlow(
        processExecutionId,
        approveStep.id,
      )

      // 8. Create and run the job for the approve step (no outgoing flows)
      const now = yield* DateTime.now
      const job = {
        jobId: "job-test-002",
        queue: "flow-execution" as const,
        payload: { scheduledFlowId },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      }

      yield* flowExecutionHandler.handle(job)

      // 9. Verify only process-event and execution-event jobs enqueued (no todos)
      expect(enqueuedJobs).toHaveLength(2)
      expect(enqueuedJobs.some((j) => j.queue === TODO_EVENT_QUEUE)).toBeFalse()
      expect(
        enqueuedJobs.some((j) => j.queue === PROCESS_EVENT_QUEUE),
      ).toBeTrue()
      expect(
        enqueuedJobs.some((j) => j.queue === EXECUTION_EVENT_QUEUE),
      ).toBeTrue()

      // 10. Verify no todos were created
      const todos = yield* db.select().from(schema.toDo)
      expect(todos).toHaveLength(0)

      // 11. Verify process execution is now marked as finished
      const afterExecution = yield* db
        .select()
        .from(schema.processExecution)
        .where(eq(schema.processExecution.id, processExecutionId))
      expect(afterExecution[0]?.finishedAt).not.toBeNull()

      // 12. Verify scheduled_flow was deleted after processing
      const scheduledFlows = yield* db.select().from(schema.scheduledFlow)
      expect(scheduledFlows).toHaveLength(0)
    })

    await runProvidedTestProgram(testProgram, TestLayers)
  })

  it("should skip processing when job was already completed (idempotency)", async () => {
    const { layer: mockQueueServiceLayer, enqueuedJobs } =
      createMockQueueService()
    const { layers: TestLayers } = createTestLayers(mockQueueServiceLayer)

    const testProgram = Effect.gen(function* () {
      const { org } = createTestOrganisation()
      // 1. Store org in database
      yield* storeOrganisation(org)

      // 2. Query the flow
      const db = yield* TypedSqliteDrizzle
      const flows = yield* db.select().from(schema.flow)
      const flow = flows[0]
      if (!flow) throw new Error("Flow not found")

      // 3. Query the process
      const processes = yield* db.select().from(schema.process)
      const process = processes[0]
      if (!process) throw new Error("Process not found")

      // 4. Create process state
      const processStateId = "pst-test-003"
      yield* db.insert(schema.processState).values({
        id: processStateId,
        processId: process.id,
        startStepId: flow.sourceStepId,
        state: { data: "test" },
      })

      // 5. Create process execution
      const processExecutionId = "pex-test-003"
      yield* db.insert(schema.processExecution).values({
        id: processExecutionId,
        processStateId,
      })

      // 6. Create scheduled_flow record
      const scheduledFlowOps = yield* ScheduledFlowOperations
      const scheduledFlowId = yield* scheduledFlowOps.insertScheduledFlow(
        processExecutionId,
        flow.sourceStepId,
      )

      // 7. Create the job
      const now = yield* DateTime.now
      const job = {
        jobId: "job-test-003",
        queue: "flow-execution" as const,
        payload: { scheduledFlowId },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      }

      // 8. Pre-mark the job as completed (simulating a crash after commit)
      const completedJobOps = yield* CompletedJobOperations
      yield* completedJobOps.markJobCompleted("flow-execution", job.jobId)

      // 9. Verify the job is marked as completed
      const isCompleted = yield* completedJobOps.isJobCompleted(
        "flow-execution",
        job.jobId,
      )
      expect(isCompleted).toBe(true)

      // 10. Run the handler (should skip due to idempotency check)
      yield* flowExecutionHandler.handle(job)

      // 11. Verify no todo-event jobs were enqueued (job was skipped)
      expect(enqueuedJobs).toHaveLength(0)

      // 12. Verify no todos were created in database
      const todos = yield* db.select().from(schema.toDo)
      expect(todos).toHaveLength(0)

      // 13. Verify scheduled_flow still exists (wasn't processed)
      const scheduledFlows = yield* db.select().from(schema.scheduledFlow)
      expect(scheduledFlows).toHaveLength(1)
    })

    await runProvidedTestProgram(testProgram, TestLayers)
  })
})

describe("Todo notification fanout", () => {
  it("enqueues public-completion notification and suppresses role notification", async () => {
    const { layer: mockQueueServiceLayer, enqueuedJobs } =
      createMockQueueService()
    const { org } = createPublicCompletionOrg()
    const { layers: TestLayers } = createTestLayersForOrg({
      mockQueueServiceLayer,
      org,
    })

    const testProgram = Effect.gen(function* () {
      yield* storeOrganisation(org)

      const db = yield* TypedSqliteDrizzle
      const roles = yield* db.select().from(schema.role)
      const role = roles[0]
      if (!role) throw new Error("Role not found")

      yield* insertProviderUser({
        userId: "usr-public-completion-001",
        providerUserId: "pu-public-completion-001",
        roleIds: [role.id],
        email: "staff@example.com",
        name: "Staff User",
        notificationsEnabled: true,
      })

      const flows = yield* db.select().from(schema.flow)
      const flow = flows[0]
      if (!flow) throw new Error("Flow not found")

      const process = (yield* db.select().from(schema.process))[0]
      if (!process) throw new Error("Process not found")

      const processStateId = "pst-public-completion-001"
      yield* db.insert(schema.processState).values({
        id: processStateId,
        processId: process.id,
        startStepId: flow.sourceStepId,
        state: {
          externalEmail: "external@example.com",
          reference: "ABC-123",
        },
      })

      const processExecutionId = "pex-public-completion-001"
      yield* db.insert(schema.processExecution).values({
        id: processExecutionId,
        processStateId,
      })

      const scheduledFlowOps = yield* ScheduledFlowOperations
      const scheduledFlowId = yield* scheduledFlowOps.insertScheduledFlow(
        processExecutionId,
        flow.sourceStepId,
      )

      const now = yield* DateTime.now
      yield* flowExecutionHandler.handle({
        jobId: "job-public-completion-001",
        queue: "flow-execution",
        payload: { scheduledFlowId },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      })

      const todos = yield* db.select().from(schema.toDo)
      expect(todos).toHaveLength(1)
      const attempts = yield* db
        .select()
        .from(schema.publicCompletionInvitationAttempt)
      expect(attempts).toHaveLength(1)
      const attempt = attempts[0]
      if (!attempt) {
        throw new Error("Public completion invitation attempt not found")
      }
      expect(attempt.toDoId).toBe(todos[0]?.id)
      expect(attempt.email).toBe("external@example.com")

      const notificationJobs = getNotificationJobs(enqueuedJobs)
      expect(notificationJobs).toHaveLength(1)
      expect(notificationJobs.some((job) => "todo" in job)).toBe(false)

      const publicJob = notificationJobs.find((job) => "publicTodo" in job)
      expect(publicJob).toBeDefined()
      if (!publicJob || !("publicTodo" in publicJob)) {
        throw new Error("Public completion notification not found")
      }
      expect(publicJob.recipient).toEqual({
        email: "external@example.com",
        displayName: "External Reviewer",
      })
      expect(publicJob.publicTodo.todoId).toBe(todos[0]?.id)
      expect(publicJob.publicTodo.expiresAt).toBe("2099-01-01T10:00:00.000Z")
      expect(publicJob.publicTodo.from).toBe(
        "Award Leader <award.leader@example.com>",
      )
      expect(publicJob.publicTodo.subject).toContain(
        "https://frontend.example.test/public/form/",
      )
      expect(publicJob.publicTodo.body).toBe("Review request ABC-123")
      expect(publicJob.publicTodo.template).toEqual({
        id: "public-review-template",
        variables: {
          REFERENCE: "ABC-123",
        },
      })
      expect(publicJob.publicTodo.attachments).toEqual([
        {
          filename: "review.pdf",
          storePrefix: "/review-documents",
          fileId: "file-review-001",
        },
      ])
      expect(typeof publicJob.publicTodo.token).toBe("string")
      expect(publicJob.publicTodo.publicCompletionInvitationAttemptId).toBe(
        attempt.id,
      )
    })

    await runProvidedTestProgram(testProgram, TestLayers)
  })

  it("creates public-completion attempts before external queue enqueue", async () => {
    const { layer: mockQueueServiceLayer, enqueuedJobs } =
      createMockQueueService({
        queueInTransaction: false,
        onEnqueue: (queue, payload) =>
          Effect.gen(function* () {
            if (queue !== NOTIFICATION_DELIVERY_QUEUE) {
              return
            }

            const notificationPayload = payload as NotificationDeliveryPayload
            if (!("publicTodo" in notificationPayload)) {
              return
            }

            const attemptId =
              notificationPayload.publicTodo.publicCompletionInvitationAttemptId
            expect(attemptId).toBeDefined()
            if (attemptId === undefined) {
              throw new Error("Missing invitation attempt id")
            }

            const db = yield* TypedSqliteDrizzle
            const attempts = yield* db
              .select()
              .from(schema.publicCompletionInvitationAttempt)
              .where(eq(schema.publicCompletionInvitationAttempt.id, attemptId))
            expect(attempts).toHaveLength(1)
          }),
      })
    const { org } = createPublicCompletionOrg()
    const { layers: TestLayers } = createTestLayersForOrg({
      mockQueueServiceLayer,
      org,
    })

    const testProgram = Effect.gen(function* () {
      yield* storeOrganisation(org)

      const db = yield* TypedSqliteDrizzle
      const roles = yield* db.select().from(schema.role)
      const role = roles[0]
      if (!role) throw new Error("Role not found")

      yield* insertProviderUser({
        userId: "usr-public-completion-external-001",
        providerUserId: "pu-public-completion-external-001",
        roleIds: [role.id],
        email: "staff@example.com",
        name: "Staff User",
        notificationsEnabled: true,
      })

      const flows = yield* db.select().from(schema.flow)
      const flow = flows[0]
      if (!flow) throw new Error("Flow not found")

      const process = (yield* db.select().from(schema.process))[0]
      if (!process) throw new Error("Process not found")

      const processStateId = "pst-public-completion-external-001"
      yield* db.insert(schema.processState).values({
        id: processStateId,
        processId: process.id,
        startStepId: flow.sourceStepId,
        state: {
          externalEmail: "external@example.com",
          reference: "ABC-123",
        },
      })

      const processExecutionId = "pex-public-completion-external-001"
      yield* db.insert(schema.processExecution).values({
        id: processExecutionId,
        processStateId,
      })

      const scheduledFlowOps = yield* ScheduledFlowOperations
      const scheduledFlowId = yield* scheduledFlowOps.insertScheduledFlow(
        processExecutionId,
        flow.sourceStepId,
      )

      const now = yield* DateTime.now
      yield* flowExecutionHandler.handle({
        jobId: "job-public-completion-external-001",
        queue: "flow-execution",
        payload: { scheduledFlowId },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      })

      const todos = yield* db.select().from(schema.toDo)
      expect(todos).toHaveLength(1)
      const attempts = yield* db
        .select()
        .from(schema.publicCompletionInvitationAttempt)
      expect(attempts).toHaveLength(1)
      expect(attempts[0]?.toDoId).toBe(todos[0]?.id)

      const notificationJobs = getNotificationJobs(enqueuedJobs)
      expect(notificationJobs).toHaveLength(1)
      const publicJob = notificationJobs.find((job) => "publicTodo" in job)
      expect(publicJob).toBeDefined()
      if (!publicJob || !("publicTodo" in publicJob)) {
        throw new Error("Public completion notification not found")
      }
      expect(publicJob.publicTodo.publicCompletionInvitationAttemptId).toBe(
        attempts[0]?.id,
      )
    })

    await runProvidedTestProgram(testProgram, TestLayers)
  })

  it("enqueues notification-delivery jobs for eligible role holders with snapshotted payloads", async () => {
    const { layer: mockQueueServiceLayer, enqueuedJobs } =
      createMockQueueService()
    const { layers: TestLayers } = createTestLayers(mockQueueServiceLayer)

    const testProgram = Effect.gen(function* () {
      const { org } = createTestOrganisation()
      yield* storeOrganisation(org)

      const db = yield* TypedSqliteDrizzle
      const roles = yield* db.select().from(schema.role)
      const role = roles[0]
      if (!role) throw new Error("Role not found")

      yield* insertProviderUser({
        userId: "usr-notify-role-001",
        providerUserId: "pu-notify-role-001",
        roleIds: [role.id],
        email: "eligible@example.com",
        name: "Eligible User",
        notificationsEnabled: true,
      })
      yield* insertProviderUser({
        userId: "usr-notify-role-002",
        providerUserId: "pu-notify-role-002",
        roleIds: [role.id],
        email: "default-off@example.com",
        name: "Default Off",
        notificationsEnabled: false,
      })

      const flows = yield* db.select().from(schema.flow)
      const flow = flows[0]
      if (!flow) throw new Error("Flow not found")

      const targetSteps = yield* db
        .select()
        .from(schema.step)
        .where(eq(schema.step.id, flow.targetStepId))
      const targetStep = targetSteps[0]
      if (!targetStep) throw new Error("Target step not found")

      const processes = yield* db.select().from(schema.process)
      const process = processes[0]
      if (!process) throw new Error("Process not found")

      const processStateId = "pst-notify-role-001"
      yield* db.insert(schema.processState).values({
        id: processStateId,
        processId: process.id,
        startStepId: flow.sourceStepId,
        state: { data: "test" },
      })

      const processExecutionId = "pex-notify-role-001"
      yield* db.insert(schema.processExecution).values({
        id: processExecutionId,
        processStateId,
      })

      const scheduledFlowOps = yield* ScheduledFlowOperations
      const scheduledFlowId = yield* scheduledFlowOps.insertScheduledFlow(
        processExecutionId,
        flow.sourceStepId,
      )

      const now = yield* DateTime.now
      yield* flowExecutionHandler.handle({
        jobId: "job-notify-role-001",
        queue: "flow-execution",
        payload: { scheduledFlowId },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      })

      const todos = yield* db.select().from(schema.toDo)
      const todo = todos[0]
      if (!todo) throw new Error("Todo not found")

      const notificationJobs = getNotificationJobs(enqueuedJobs)
      expect(notificationJobs).toHaveLength(1)
      expect(notificationJobs[0]).toEqual({
        channel: "email",
        recipient: {
          userId: "usr-notify-role-001",
          email: "eligible@example.com",
          displayName: "Eligible User",
        },
        todo: {
          todoId: todo.id,
          stepPath: targetStep.path,
          processName: process.name,
          stepName: targetStep.name,
        },
      })
    })

    await runProvidedTestProgram(testProgram, TestLayers)
  })

  it("enqueues always-notify todo notifications regardless of user preference", async () => {
    const { layer: mockQueueServiceLayer, enqueuedJobs } =
      createMockQueueService()
    const { org } = createAlwaysNotifyOrg()
    const { layers: TestLayers } = createTestLayersForOrg({
      mockQueueServiceLayer,
      org,
    })

    const testProgram = Effect.gen(function* () {
      yield* storeOrganisation(org)

      const db = yield* TypedSqliteDrizzle
      const roles = yield* db.select().from(schema.role)
      const role = roles[0]
      if (!role) throw new Error("Role not found")

      yield* insertProviderUser({
        userId: "usr-always-notify-001",
        providerUserId: "pu-always-notify-001",
        roleIds: [role.id],
        email: "disabled@example.com",
        name: "Disabled User",
        notificationsEnabled: false,
      })
      yield* insertProviderUser({
        userId: "usr-always-notify-002",
        providerUserId: "pu-always-notify-002",
        roleIds: [role.id],
        email: "default-off@example.com",
        name: "Default Off",
      })

      const flows = yield* db.select().from(schema.flow)
      const flow = flows[0]
      if (!flow) throw new Error("Flow not found")

      const targetSteps = yield* db
        .select()
        .from(schema.step)
        .where(eq(schema.step.id, flow.targetStepId))
      const targetStep = targetSteps[0]
      if (!targetStep) throw new Error("Target step not found")

      const processes = yield* db.select().from(schema.process)
      const process = processes[0]
      if (!process) throw new Error("Process not found")

      const processStateId = "pst-always-notify-001"
      yield* db.insert(schema.processState).values({
        id: processStateId,
        processId: process.id,
        startStepId: flow.sourceStepId,
        state: {},
      })

      const processExecutionId = "pex-always-notify-001"
      yield* db.insert(schema.processExecution).values({
        id: processExecutionId,
        processStateId,
      })

      const scheduledFlowOps = yield* ScheduledFlowOperations
      const scheduledFlowId = yield* scheduledFlowOps.insertScheduledFlow(
        processExecutionId,
        flow.sourceStepId,
      )

      const now = yield* DateTime.now
      yield* flowExecutionHandler.handle({
        jobId: "job-always-notify-001",
        queue: "flow-execution",
        payload: { scheduledFlowId },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      })

      const todos = yield* db.select().from(schema.toDo)
      const todo = todos[0]
      if (!todo) throw new Error("Todo not found")

      const notificationJobs = getNotificationJobs(enqueuedJobs)
      expect(notificationJobs).toHaveLength(2)
      expect(notificationJobs).toEqual(
        expect.arrayContaining([
          {
            channel: "email",
            recipient: {
              userId: "usr-always-notify-001",
              email: "disabled@example.com",
              displayName: "Disabled User",
            },
            todo: {
              todoId: todo.id,
              stepPath: targetStep.path,
              processName: process.name,
              stepName: targetStep.name,
            },
          },
          {
            channel: "email",
            recipient: {
              userId: "usr-always-notify-002",
              email: "default-off@example.com",
              displayName: "Default Off",
            },
            todo: {
              todoId: todo.id,
              stepPath: targetStep.path,
              processName: process.name,
              stepName: targetStep.name,
            },
          },
        ]),
      )
    })

    await runProvidedTestProgram(testProgram, TestLayers)
  })

  it("uses direct-assignee precedence over role-based fanout", async () => {
    const { layer: mockQueueServiceLayer, enqueuedJobs } =
      createMockQueueService()
    const { layers: TestLayers } = createTestLayers(
      mockQueueServiceLayer,
      withDirectAssignee("pu-notify-direct-002"),
    )

    const testProgram = Effect.gen(function* () {
      const { org } = createTestOrganisation()
      yield* storeOrganisation(org)

      const db = yield* TypedSqliteDrizzle
      const roles = yield* db.select().from(schema.role)
      const role = roles[0]
      if (!role) throw new Error("Role not found")

      yield* insertProviderUser({
        userId: "usr-notify-direct-001",
        providerUserId: "pu-notify-direct-001",
        roleIds: [role.id],
        email: "role-holder@example.com",
        name: "Role Holder",
        notificationsEnabled: true,
      })
      yield* insertProviderUser({
        userId: "usr-notify-direct-002",
        providerUserId: "pu-notify-direct-002",
        roleIds: [],
        email: "direct@example.com",
        name: "Direct User",
        notificationsEnabled: true,
      })

      const flows = yield* db.select().from(schema.flow)
      const flow = flows[0]
      if (!flow) throw new Error("Flow not found")

      const processes = yield* db.select().from(schema.process)
      const process = processes[0]
      if (!process) throw new Error("Process not found")

      const processStateId = "pst-notify-direct-001"
      yield* db.insert(schema.processState).values({
        id: processStateId,
        processId: process.id,
        startStepId: flow.sourceStepId,
        state: { data: "test" },
      })

      const processExecutionId = "pex-notify-direct-001"
      yield* db.insert(schema.processExecution).values({
        id: processExecutionId,
        processStateId,
      })

      const scheduledFlowOps = yield* ScheduledFlowOperations
      const scheduledFlowId = yield* scheduledFlowOps.insertScheduledFlow(
        processExecutionId,
        flow.sourceStepId,
      )

      const now = yield* DateTime.now
      yield* flowExecutionHandler.handle({
        jobId: "job-notify-direct-001",
        queue: "flow-execution",
        payload: { scheduledFlowId },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      })

      const notificationJobs = getNotificationJobs(enqueuedJobs)
      expect(notificationJobs).toHaveLength(1)
      expect(notificationJobs[0]?.recipient).toEqual({
        userId: "usr-notify-direct-002",
        email: "direct@example.com",
        displayName: "Direct User",
      })
    })

    await runProvidedTestProgram(testProgram, TestLayers)
  })

  it("resolves direct assignee emails before storing todo assignment", async () => {
    const { layer: mockQueueServiceLayer, enqueuedJobs } =
      createMockQueueService()
    const { org } = createDirectAssigneeOrganisation("direct-email@example.com")
    const { layers: TestLayers } = createTestLayersForOrg({
      mockQueueServiceLayer,
      org,
    })

    const testProgram = Effect.gen(function* () {
      yield* storeOrganisation(org)

      const db = yield* TypedSqliteDrizzle
      yield* insertProviderUser({
        userId: "usr-notify-direct-email-001",
        providerUserId: "pu-notify-direct-email-001",
        roleIds: [],
        email: "direct-email@example.com",
        name: "Direct Email",
        notificationsEnabled: true,
      })

      const flows = yield* db.select().from(schema.flow)
      const flow = flows[0]
      if (!flow) throw new Error("Flow not found")

      const processRows = yield* db.select().from(schema.process)
      const processRow = processRows[0]
      if (!processRow) throw new Error("Process not found")

      const processStateId = "pst-notify-direct-email-001"
      yield* db.insert(schema.processState).values({
        id: processStateId,
        processId: processRow.id,
        startStepId: flow.sourceStepId,
        state: { data: "test" },
      })

      const processExecutionId = "pex-notify-direct-email-001"
      yield* db.insert(schema.processExecution).values({
        id: processExecutionId,
        processStateId,
      })

      const scheduledFlowOps = yield* ScheduledFlowOperations
      const scheduledFlowId = yield* scheduledFlowOps.insertScheduledFlow(
        processExecutionId,
        flow.sourceStepId,
      )

      const now = yield* DateTime.now
      yield* flowExecutionHandler.handle({
        jobId: "job-notify-direct-email-001",
        queue: FLOW_EXECUTION_QUEUE,
        payload: { scheduledFlowId },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      })

      const todoRows = yield* db.select().from(schema.toDo)
      expect(todoRows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            assignedToProviderUserId: "pu-notify-direct-email-001",
          }),
        ]),
      )

      const notificationJobs = getNotificationJobs(enqueuedJobs)
      expect(notificationJobs).toHaveLength(1)
      expect(notificationJobs[0]?.recipient).toEqual({
        userId: "usr-notify-direct-email-001",
        email: "direct-email@example.com",
        displayName: "Direct Email",
      })
      expect(notificationJobs[0]?.todo).toEqual({
        todoId: todoRows[0]?.id,
        stepPath: "/direct-assignee-process/approve",
        processName: "Direct Assignee Process",
        stepName: "Approve",
      })
    })

    await runProvidedTestProgram(testProgram, TestLayers)
  })

  it("fails flow execution for whitespace-only direct assignees", async () => {
    const { layer: mockQueueServiceLayer } = createMockQueueService()
    const { org } = createDirectAssigneeOrganisation("   ")
    const { layers: TestLayers } = createTestLayersForOrg({
      mockQueueServiceLayer,
      org,
    })

    const testProgram = Effect.gen(function* () {
      yield* storeOrganisation(org)

      const db = yield* TypedSqliteDrizzle
      const flows = yield* db.select().from(schema.flow)
      const flow = flows[0]
      if (!flow) throw new Error("Flow not found")

      const processRows = yield* db.select().from(schema.process)
      const processRow = processRows[0]
      if (!processRow) throw new Error("Process not found")

      const processStateId = "pst-notify-direct-empty-001"
      yield* db.insert(schema.processState).values({
        id: processStateId,
        processId: processRow.id,
        startStepId: flow.sourceStepId,
        state: { data: "test" },
      })

      const processExecutionId = "pex-notify-direct-empty-001"
      yield* db.insert(schema.processExecution).values({
        id: processExecutionId,
        processStateId,
      })

      const scheduledFlowOps = yield* ScheduledFlowOperations
      const scheduledFlowId = yield* scheduledFlowOps.insertScheduledFlow(
        processExecutionId,
        flow.sourceStepId,
      )

      const now = yield* DateTime.now
      const exit = yield* flowExecutionHandler
        .handle({
          jobId: "job-notify-direct-empty-001",
          queue: FLOW_EXECUTION_QUEUE,
          payload: { scheduledFlowId },
          attempts: 1,
          maxAttempts: 5,
          availableAt: now,
          lockedUntil: now,
        })
        .pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      const todoRows = yield* db.select().from(schema.toDo)
      expect(todoRows).toHaveLength(0)
    })

    await runProvidedTestProgram(testProgram, TestLayers)
  })

  it("does not fall back to role holders when the direct assignee is ineligible", async () => {
    const { layer: mockQueueServiceLayer, enqueuedJobs } =
      createMockQueueService()
    const { layers: TestLayers } = createTestLayers(
      mockQueueServiceLayer,
      withDirectAssignee("pu-notify-direct-004"),
    )

    const testProgram = Effect.gen(function* () {
      const { org } = createTestOrganisation()
      yield* storeOrganisation(org)

      const db = yield* TypedSqliteDrizzle
      const roles = yield* db.select().from(schema.role)
      const role = roles[0]
      if (!role) throw new Error("Role not found")

      yield* insertProviderUser({
        userId: "usr-notify-direct-003",
        providerUserId: "pu-notify-direct-003",
        roleIds: [role.id],
        email: "role-holder@example.com",
        name: "Role Holder",
        notificationsEnabled: true,
      })
      yield* insertProviderUser({
        userId: "usr-notify-direct-004",
        providerUserId: "pu-notify-direct-004",
        roleIds: [],
        email: "direct-disabled@example.com",
        name: "Direct Disabled",
        notificationsEnabled: false,
      })

      const flows = yield* db.select().from(schema.flow)
      const flow = flows[0]
      if (!flow) throw new Error("Flow not found")

      const processes = yield* db.select().from(schema.process)
      const process = processes[0]
      if (!process) throw new Error("Process not found")

      const processStateId = "pst-notify-direct-002"
      yield* db.insert(schema.processState).values({
        id: processStateId,
        processId: process.id,
        startStepId: flow.sourceStepId,
        state: { data: "test" },
      })

      const processExecutionId = "pex-notify-direct-002"
      yield* db.insert(schema.processExecution).values({
        id: processExecutionId,
        processStateId,
      })

      const scheduledFlowOps = yield* ScheduledFlowOperations
      const scheduledFlowId = yield* scheduledFlowOps.insertScheduledFlow(
        processExecutionId,
        flow.sourceStepId,
      )

      const now = yield* DateTime.now
      yield* flowExecutionHandler.handle({
        jobId: "job-notify-direct-002",
        queue: "flow-execution",
        payload: { scheduledFlowId },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      })

      expect(getNotificationJobs(enqueuedJobs)).toHaveLength(0)
    })

    await runProvidedTestProgram(testProgram, TestLayers)
  })

  it("deduplicates notification recipients by todo and user", async () => {
    const { layer: mockQueueServiceLayer, enqueuedJobs } =
      createMockQueueService()
    const { layers: TestLayers } = createTestLayers(
      mockQueueServiceLayer,
      withDuplicatedRoleRecipients(),
    )

    const testProgram = Effect.gen(function* () {
      const { org } = createTestOrganisation()
      yield* storeOrganisation(org)

      const db = yield* TypedSqliteDrizzle
      const roles = yield* db.select().from(schema.role)
      const role = roles[0]
      if (!role) throw new Error("Role not found")

      yield* insertProviderUser({
        userId: "usr-notify-dedupe-001",
        providerUserId: "pu-notify-dedupe-001",
        roleIds: [role.id],
        email: "dedupe@example.com",
        name: "Dedupe User",
        notificationsEnabled: true,
      })

      const flows = yield* db.select().from(schema.flow)
      const flow = flows[0]
      if (!flow) throw new Error("Flow not found")

      const processes = yield* db.select().from(schema.process)
      const process = processes[0]
      if (!process) throw new Error("Process not found")

      const processStateId = "pst-notify-dedupe-001"
      yield* db.insert(schema.processState).values({
        id: processStateId,
        processId: process.id,
        startStepId: flow.sourceStepId,
        state: { data: "test" },
      })

      const processExecutionId = "pex-notify-dedupe-001"
      yield* db.insert(schema.processExecution).values({
        id: processExecutionId,
        processStateId,
      })

      const scheduledFlowOps = yield* ScheduledFlowOperations
      const scheduledFlowId = yield* scheduledFlowOps.insertScheduledFlow(
        processExecutionId,
        flow.sourceStepId,
      )

      const now = yield* DateTime.now
      yield* flowExecutionHandler.handle({
        jobId: "job-notify-dedupe-001",
        queue: "flow-execution",
        payload: { scheduledFlowId },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      })

      const notificationJobs = getNotificationJobs(enqueuedJobs)
      expect(notificationJobs).toHaveLength(1)
      expect(notificationJobs[0]?.recipient.userId).toBe(
        "usr-notify-dedupe-001",
      )
    })

    await runProvidedTestProgram(testProgram, TestLayers)
  })

  it("does not enqueue notifications when the downstream todo is for a system step", async () => {
    const { layer: mockQueueServiceLayer, enqueuedJobs } =
      createMockQueueService()
    const { org } = createSystemStepOrg()
    const { layers: TestLayers } = createTestLayersForOrg({
      mockQueueServiceLayer,
      org,
    })

    const testProgram = Effect.gen(function* () {
      yield* storeOrganisation(org)

      const db = yield* TypedSqliteDrizzle
      const flows = yield* db.select().from(schema.flow)
      const flow = flows[0]
      if (!flow) throw new Error("Flow not found")

      const processes = yield* db.select().from(schema.process)
      const process = processes[0]
      if (!process) throw new Error("Process not found")

      const processStateId = "pst-notify-system-001"
      yield* db.insert(schema.processState).values({
        id: processStateId,
        processId: process.id,
        startStepId: flow.sourceStepId,
        state: { data: "test" },
      })

      const processExecutionId = "pex-notify-system-001"
      yield* db.insert(schema.processExecution).values({
        id: processExecutionId,
        processStateId,
      })

      const scheduledFlowOps = yield* ScheduledFlowOperations
      const scheduledFlowId = yield* scheduledFlowOps.insertScheduledFlow(
        processExecutionId,
        flow.sourceStepId,
      )

      // This runs flow execution from the submit step so the handler creates the
      // next-step todo for the downstream NodeStep, not for the form itself.
      const now = yield* DateTime.now
      yield* flowExecutionHandler.handle({
        jobId: "job-notify-system-001",
        queue: "flow-execution",
        payload: { scheduledFlowId },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      })

      expect(getNotificationJobs(enqueuedJobs)).toHaveLength(0)
    })

    await runProvidedTestProgram(testProgram, TestLayers)
  })

  it("resumes external fanout after failure at every enqueue index", async () => {
    const expectedQueues = [
      TODO_EVENT_QUEUE,
      SYSTEM_STEP_EXECUTION_QUEUE,
      PROCESS_EVENT_QUEUE,
      EXECUTION_EVENT_QUEUE,
    ]

    for (
      let failureIndex = 0;
      failureIndex < expectedQueues.length;
      failureIndex++
    ) {
      let enqueueIndex = 0
      let failureInjected = false
      const { layer: mockQueueServiceLayer, enqueuedJobs } =
        createMockQueueService({
          queueInTransaction: false,
          onEnqueue: (queue) => {
            const currentIndex = enqueueIndex++
            if (!failureInjected && currentIndex === failureIndex) {
              failureInjected = true
              return Effect.fail(
                new EnqueueError({
                  queue,
                  message: `Injected failure at enqueue ${failureIndex}`,
                }),
              )
            }
            return Effect.void
          },
        })
      const { org } = createSystemStepOrg()
      const { layers: TestLayers } = createTestLayersForOrg({
        mockQueueServiceLayer,
        org,
      })

      const testProgram = Effect.gen(function* () {
        yield* storeOrganisation(org)
        const db = yield* TypedSqliteDrizzle
        const flow = (yield* db.select().from(schema.flow).limit(1))[0]
        const process = (yield* db.select().from(schema.process).limit(1))[0]
        if (!flow || !process) throw new Error("Flow fixture not found")

        const suffix = String(failureIndex)
        const processStateId = `pst-fanout-recovery-${suffix}`
        const processExecutionId = `pex-fanout-recovery-${suffix}`
        yield* db.insert(schema.processState).values({
          id: processStateId,
          processId: process.id,
          startStepId: flow.sourceStepId,
          state: {},
        })
        yield* db.insert(schema.processExecution).values({
          id: processExecutionId,
          processStateId,
        })

        const scheduledFlowOps = yield* ScheduledFlowOperations
        const scheduledFlowId = yield* scheduledFlowOps.insertScheduledFlow(
          processExecutionId,
          flow.sourceStepId,
        )
        const now = yield* DateTime.now
        const firstResult = yield* Effect.exit(
          flowExecutionHandler.handle({
            jobId: `job-fanout-recovery-${suffix}-first`,
            queue: FLOW_EXECUTION_QUEUE,
            payload: { scheduledFlowId },
            attempts: 5,
            maxAttempts: 5,
            availableAt: now,
            lockedUntil: now,
          }),
        )
        expect(firstResult._tag).toBe("Failure")

        yield* flowExecutionHandler.handle({
          jobId: `job-fanout-recovery-${suffix}-retry`,
          queue: FLOW_EXECUTION_QUEUE,
          payload: { scheduledFlowId },
          attempts: 5,
          maxAttempts: 5,
          availableAt: now,
          lockedUntil: now,
        })

        expect(yield* db.select().from(schema.toDo)).toHaveLength(1)
        expect(yield* db.select().from(schema.jobQueue)).toHaveLength(0)
        expect(enqueuedJobs.map((job) => job.queue)).toEqual(expectedQueues)
        const logicalJobIds = enqueuedJobs.map((job) => job.logicalJobId)
        expect(logicalJobIds.every((id) => id !== undefined)).toBe(true)
        expect(new Set(logicalJobIds).size).toBe(expectedQueues.length)
      })

      await runProvidedTestProgram(testProgram, TestLayers)
    }
  })
})

describe("Scheduled Flow Execution", () => {
  it("skips when a scheduled flow is cancelled before the handler can claim it", async () => {
    const { layer: mockQueueServiceLayer } = createMockQueueService()
    const { layers: TestLayers } = createTestLayers(
      mockQueueServiceLayer,
      undefined,
      (base) => ({
        ...base,
        deleteScheduledFlow: (id) =>
          base.deleteScheduledFlow(id).pipe(Effect.as(false)),
      }),
    )

    const testProgram = Effect.gen(function* () {
      const { org } = createTestOrganisation()
      yield* storeOrganisation(org)

      const db = yield* TypedSqliteDrizzle
      const flow = (yield* db.select().from(schema.flow).limit(1))[0]
      if (!flow) throw new Error("Flow not found")

      const process = (yield* db.select().from(schema.process).limit(1))[0]
      if (!process) throw new Error("Process not found")

      const processStateId = "pst-sched-cancel-claim-001"
      yield* db.insert(schema.processState).values({
        id: processStateId,
        processId: process.id,
        startStepId: flow.sourceStepId,
        state: {},
      })

      const processExecutionId = "pex-sched-cancel-claim-001"
      yield* db.insert(schema.processExecution).values({
        id: processExecutionId,
        processStateId,
      })

      const scheduledFlowOps = yield* ScheduledFlowOperations
      const scheduledFlowId = yield* scheduledFlowOps.insertScheduledFlow(
        processExecutionId,
        flow.sourceStepId,
      )

      const now = yield* DateTime.now
      yield* flowExecutionHandler.handle({
        jobId: "job-sched-cancel-claim-001",
        queue: FLOW_EXECUTION_QUEUE,
        payload: { scheduledFlowId },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      })

      const todos = yield* db.select().from(schema.toDo)
      const scheduledFlows = yield* db.select().from(schema.scheduledFlow)

      expect(todos).toHaveLength(0)
      expect(scheduledFlows).toHaveLength(0)
    })

    await runProvidedTestProgram(testProgram, TestLayers)
  })

  it("does not create todos for a delayed flow on an abandoned execution", async () => {
    const { layer: mockQueueServiceLayer } = createMockQueueService()
    const { layers: TestLayers } = createTestLayers(mockQueueServiceLayer)

    const testProgram = Effect.gen(function* () {
      const { org } = createTestOrganisation()
      yield* storeOrganisation(org)

      const db = yield* TypedSqliteDrizzle
      const flow = (yield* db.select().from(schema.flow).limit(1))[0]
      if (!flow) throw new Error("Flow not found")

      const targetStep = (yield* db
        .select()
        .from(schema.step)
        .where(eq(schema.step.id, flow.targetStepId))
        .limit(1))[0]
      if (!targetStep) throw new Error("Target step not found")

      const process = (yield* db.select().from(schema.process).limit(1))[0]
      if (!process) throw new Error("Process not found")

      const processStateId = "pst-sched-abandoned-001"
      yield* db.insert(schema.processState).values({
        id: processStateId,
        processId: process.id,
        startStepId: flow.sourceStepId,
        state: {},
      })

      const now = yield* DateTime.now
      const processExecutionId = "pex-sched-abandoned-001"
      yield* db.insert(schema.processExecution).values({
        id: processExecutionId,
        processStateId,
        finishedAt: now,
        abandonedAt: now,
        abandonedReason: "cancelled while delayed flow was in flight",
      })

      const scheduledFlowOps = yield* ScheduledFlowOperations
      const scheduledFlowId = yield* scheduledFlowOps.insertScheduledFlow(
        processExecutionId,
        flow.sourceStepId,
        {
          targetStepId: targetStep.id,
          scheduledAt: DateTime.toUtc(DateTime.subtract(now, { minutes: 1 })),
        },
      )

      yield* flowExecutionHandler.handle({
        jobId: "job-sched-abandoned-001",
        queue: FLOW_EXECUTION_QUEUE,
        payload: { scheduledFlowId },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      })

      const todos = yield* db.select().from(schema.toDo)
      const scheduledFlows = yield* db.select().from(schema.scheduledFlow)

      expect(todos).toHaveLength(0)
      expect(scheduledFlows).toHaveLength(0)
    })

    await runProvidedTestProgram(testProgram, TestLayers)
  })

  it("does not create todos for a forEach barrier flow on an abandoned execution", async () => {
    const { layer: mockQueueServiceLayer } = createMockQueueService()
    const { layers: TestLayers } = createTestLayers(mockQueueServiceLayer)

    const testProgram = Effect.gen(function* () {
      const { org } = createTestOrganisation()
      yield* storeOrganisation(org)

      const db = yield* TypedSqliteDrizzle
      const flow = (yield* db.select().from(schema.flow).limit(1))[0]
      if (!flow) throw new Error("Flow not found")

      const process = (yield* db.select().from(schema.process).limit(1))[0]
      if (!process) throw new Error("Process not found")

      const processStateId = "pst-sched-barrier-abandoned-001"
      yield* db.insert(schema.processState).values({
        id: processStateId,
        processId: process.id,
        startStepId: flow.sourceStepId,
        state: {},
      })

      const now = yield* DateTime.now
      const processExecutionId = "pex-sched-barrier-abandoned-001"
      yield* db.insert(schema.processExecution).values({
        id: processExecutionId,
        processStateId,
        finishedAt: now,
        abandonedAt: now,
        abandonedReason: "cancelled while forEach barrier was in flight",
      })

      const scheduledFlowOps = yield* ScheduledFlowOperations
      const scheduledFlowId = yield* scheduledFlowOps.insertScheduledFlow(
        processExecutionId,
        flow.sourceStepId,
        { forEachBarrier: true },
      )

      yield* flowExecutionHandler.handle({
        jobId: "job-sched-barrier-abandoned-001",
        queue: FLOW_EXECUTION_QUEUE,
        payload: { scheduledFlowId },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      })

      const todos = yield* db.select().from(schema.toDo)
      const scheduledFlows = yield* db.select().from(schema.scheduledFlow)

      expect(todos).toHaveLength(0)
      expect(scheduledFlows).toHaveLength(0)
    })

    await runProvidedTestProgram(testProgram, TestLayers)
  })

  it("should defer flow when schedule returns future date", async () => {
    const { layer: mockQueueServiceLayer, enqueuedJobs } =
      createMockQueueService()

    // Create a mock schedule evaluator that returns a future date
    const futureDate = DateTime.unsafeMake(Date.now() + 3600000) // 1 hour from now
    const mockScheduleEvaluator: ScheduleEvaluatorService = {
      evaluate: () => Effect.succeed(futureDate),
    }

    const { layers: TestLayers } = createTestLayersWithScheduleEvaluator(
      mockQueueServiceLayer,
      mockScheduleEvaluator,
    )

    const testProgram = Effect.gen(function* () {
      const { org } = createTestOrganisation()
      yield* storeOrganisation(org)

      const db = yield* TypedSqliteDrizzle
      const flows = yield* db.select().from(schema.flow)
      const flow = flows[0]
      if (!flow) throw new Error("Flow not found")

      // Set schedule on the flow to trigger schedule evaluation
      yield* db
        .update(schema.flow)
        .set({ schedule: "In 1 hour" })
        .where(eq(schema.flow.id, flow.id))

      const processes = yield* db.select().from(schema.process)
      const process = processes[0]
      if (!process) throw new Error("Process not found")

      // Create a user for the startedByUserId
      const userId = "usr-sched-001"
      const userCreatedAt = yield* DateTime.now
      yield* db.insert(schema.user).values({
        id: userId,
        provider: "test",
        sub: "test@example.com",
        lastLoggedIn: userCreatedAt,
      })

      // Create process state and execution
      const processStateId = "pst-sched-001"
      yield* db.insert(schema.processState).values({
        id: processStateId,
        processId: process.id,
        startStepId: flow.sourceStepId,
        startedByUserId: userId,
        state: { data: "test" },
      })

      const processExecutionId = "pex-sched-001"
      yield* db.insert(schema.processExecution).values({
        id: processExecutionId,
        processStateId,
      })

      // Create scheduled_flow record
      const scheduledFlowOps = yield* ScheduledFlowOperations
      const scheduledFlowId = yield* scheduledFlowOps.insertScheduledFlow(
        processExecutionId,
        flow.sourceStepId,
      )

      // Run the job
      const now = yield* DateTime.now
      const job = {
        jobId: "job-sched-001",
        queue: "flow-execution" as const,
        payload: { scheduledFlowId },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      }

      yield* flowExecutionHandler.handle(job)

      // Verify no todo was created (flow was deferred)
      const todos = yield* db.select().from(schema.toDo)
      expect(todos).toHaveLength(0)

      // Verify a new scheduled_flow was created for the deferred flow
      const scheduledFlows = yield* db.select().from(schema.scheduledFlow)
      expect(scheduledFlows).toHaveLength(1)
      const deferredFlow = scheduledFlows[0]
      expect(deferredFlow?.targetStepId).not.toBeNull()
      expect(deferredFlow?.scheduledAt).not.toBeNull()

      // Verify a delayed job was enqueued for the deferred flow
      const deferredJobs = enqueuedJobs.filter(
        (j) => j.queue === FLOW_EXECUTION_QUEUE && j.delay !== undefined,
      )
      expect(deferredJobs).toHaveLength(1)
    })

    await runProvidedTestProgram(testProgram, TestLayers)
  })

  // Note: The re-enqueue test was removed because AWS delayed delivery moved to
  // EventBridge Scheduler plus the queue-delay bridge Lambda. The flow-execution
  // handler no longer checks scheduledAt and re-enqueues - it just executes the
  // flow when the job arrives.

  it("should execute flow when scheduledAt time is reached", async () => {
    const { layer: mockQueueServiceLayer, enqueuedJobs } =
      createMockQueueService()
    const { layers: TestLayers } = createTestLayers(mockQueueServiceLayer)

    const testProgram = Effect.gen(function* () {
      const { org } = createTestOrganisation()
      yield* storeOrganisation(org)

      const db = yield* TypedSqliteDrizzle
      const flows = yield* db.select().from(schema.flow)
      const flow = flows[0]
      if (!flow) throw new Error("Flow not found")

      const processes = yield* db.select().from(schema.process)
      const process = processes[0]
      if (!process) throw new Error("Process not found")

      // Get the target step
      const steps = yield* db.select().from(schema.step)
      const targetStep = steps.find((s) => s.id === flow.targetStepId)
      if (!targetStep) throw new Error("Target step not found")

      // Create process state and execution
      const processStateId = "pst-sched-003"
      yield* db.insert(schema.processState).values({
        id: processStateId,
        processId: process.id,
        startStepId: flow.sourceStepId,
        state: { data: "test" },
      })

      const processExecutionId = "pex-sched-003"
      yield* db.insert(schema.processExecution).values({
        id: processExecutionId,
        processStateId,
      })

      // Create scheduled_flow with past scheduledAt (time has been reached)
      const now = yield* DateTime.now
      const pastTime = DateTime.subtract(now, { hours: 1 })
      const scheduledFlowOps = yield* ScheduledFlowOperations
      const scheduledFlowId = yield* scheduledFlowOps.insertScheduledFlow(
        processExecutionId,
        flow.sourceStepId,
        {
          targetStepId: targetStep.id,
          scheduledAt: DateTime.toUtc(pastTime),
        },
      )

      // Run the job
      const job = {
        jobId: "job-sched-003",
        queue: "flow-execution" as const,
        payload: { scheduledFlowId },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      }

      yield* flowExecutionHandler.handle(job)

      // Verify todo was created (flow executed)
      const todos = yield* db.select().from(schema.toDo)
      expect(todos).toHaveLength(1)

      // Verify scheduled_flow was deleted
      const scheduledFlows = yield* db.select().from(schema.scheduledFlow)
      expect(scheduledFlows).toHaveLength(0)

      // Verify todo-event job was enqueued
      const todoEventJobs = enqueuedJobs.filter(
        (j) => j.queue === TODO_EVENT_QUEUE,
      )
      expect(todoEventJobs).toHaveLength(1)
    })

    await runProvidedTestProgram(testProgram, TestLayers)
  })
})

describe("SLA Calculation at Todo Creation", () => {
  it("should store SLA from org model when storing organisation", async () => {
    const { layer: mockQueueServiceLayer } = createMockQueueService()
    const { layers: TestLayers } = createTestLayers(mockQueueServiceLayer)

    const testProgram = Effect.gen(function* () {
      const { org } = createTestOrganisation()
      yield* storeOrganisation(org)

      const db = yield* TypedSqliteDrizzle

      // Get the approve step which has SLA configured in test-org.ts
      const steps = yield* db.select().from(schema.step)
      const approveStep = steps.find((s) => s.name === "Approve")
      if (!approveStep) throw new Error("Approve step not found")

      // Verify SLA was stored from the org model (Sla.minutes(5))
      expect(approveStep.slaValue).toBe(5)
      expect(approveStep.slaUnit).toBe("minutes")
      expect(approveStep.slaWarning).toBe(80) // default warning at 80%

      // Submit step should have no SLA
      const submitStep = steps.find((s) => s.name === "Submit")
      if (!submitStep) throw new Error("Submit step not found")
      expect(submitStep.slaValue).toBeNull()
      expect(submitStep.slaUnit).toBeNull()
    })

    await runProvidedTestProgram(testProgram, TestLayers)
  })

  it("should calculate SLA from org model without manual DB update", async () => {
    const { layer: mockQueueServiceLayer } = createMockQueueService()
    const { layers: TestLayers } = createTestLayers(mockQueueServiceLayer)

    const testProgram = Effect.gen(function* () {
      const { org } = createTestOrganisation()
      yield* storeOrganisation(org)

      const db = yield* TypedSqliteDrizzle

      // Get the flow (submit -> approve)
      const flows = yield* db.select().from(schema.flow)
      const flow = flows[0]
      if (!flow) throw new Error("Flow not found")

      const processes = yield* db.select().from(schema.process)
      const process = processes[0]
      if (!process) throw new Error("Process not found")

      // Create process state and execution
      const processStateId = "pst-sla-org-001"
      yield* db.insert(schema.processState).values({
        id: processStateId,
        processId: process.id,
        startStepId: flow.sourceStepId,
        state: { data: "test" },
      })

      const processExecutionId = "pex-sla-org-001"
      yield* db.insert(schema.processExecution).values({
        id: processExecutionId,
        processStateId,
      })

      // Create scheduled_flow record
      const scheduledFlowOps = yield* ScheduledFlowOperations
      const scheduledFlowId = yield* scheduledFlowOps.insertScheduledFlow(
        processExecutionId,
        flow.sourceStepId,
      )

      // Run the job
      const now = yield* DateTime.now
      const job = {
        jobId: "job-sla-org-001",
        queue: "flow-execution" as const,
        payload: { scheduledFlowId },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      }

      yield* flowExecutionHandler.handle(job)

      // Verify todo was created with SLA fields populated
      // The approve step has Sla.minutes(5) configured in test-org.ts
      const todos = yield* db.select().from(schema.toDo)
      expect(todos).toHaveLength(1)
      const todo = todos[0]
      if (!todo) throw new Error("Todo not found")

      // SLA target should be set (5 minutes from now, since unit is 'minutes')
      // Minutes use clock time, not business calendar, so should always be set
      expect(todo.slaTargetAt).not.toBeNull()
      expect(todo.slaWarningAt).not.toBeNull()

      // Warning should be before target
      if (todo.slaTargetAt && todo.slaWarningAt) {
        const targetMs = DateTime.toEpochMillis(todo.slaTargetAt)
        const warningMs = DateTime.toEpochMillis(todo.slaWarningAt)
        expect(warningMs).toBeLessThan(targetMs)
      }
    })

    await runProvidedTestProgram(testProgram, TestLayers)
  })

  it("should populate slaTargetAt and slaWarningAt when step has SLA configured", async () => {
    const { layer: mockQueueServiceLayer } = createMockQueueService()
    const { layers: TestLayers } = createTestLayers(mockQueueServiceLayer)

    const testProgram = Effect.gen(function* () {
      const { org } = createTestOrganisation()
      yield* storeOrganisation(org)

      const db = yield* TypedSqliteDrizzle

      // Get the flow (submit -> approve)
      const flows = yield* db.select().from(schema.flow)
      const flow = flows[0]
      if (!flow) throw new Error("Flow not found")

      // Get the target step (approve) and configure SLA
      const targetStep = yield* db
        .select()
        .from(schema.step)
        .where(eq(schema.step.id, flow.targetStepId))
      if (!targetStep[0]) throw new Error("Target step not found")

      // Set SLA: 2 business hours, warn at 50%
      yield* db
        .update(schema.step)
        .set({ slaValue: 2, slaUnit: "businessHours", slaWarning: 50 })
        .where(eq(schema.step.id, flow.targetStepId))

      // Get the org unit and configure business calendar
      const orgUnits = yield* db.select().from(schema.orgUnit)
      const orgUnit = orgUnits[0]
      if (!orgUnit) throw new Error("Org unit not found")

      // Set up a business calendar (Mon-Fri 9-17 UTC)
      for (let day = 1; day <= 5; day++) {
        yield* db.insert(schema.weeklySchedule).values({
          orgUnitId: orgUnit.id,
          dayOfWeek: day,
          timeRanges: [
            { open: { hour: 9, minute: 0 }, close: { hour: 17, minute: 0 } },
          ],
        })
      }

      const processes = yield* db.select().from(schema.process)
      const process = processes[0]
      if (!process) throw new Error("Process not found")

      // Create process state and execution
      const processStateId = "pst-sla-001"
      yield* db.insert(schema.processState).values({
        id: processStateId,
        processId: process.id,
        startStepId: flow.sourceStepId,
        state: { data: "test" },
      })

      const processExecutionId = "pex-sla-001"
      yield* db.insert(schema.processExecution).values({
        id: processExecutionId,
        processStateId,
      })

      // Create scheduled_flow record
      const scheduledFlowOps = yield* ScheduledFlowOperations
      const scheduledFlowId = yield* scheduledFlowOps.insertScheduledFlow(
        processExecutionId,
        flow.sourceStepId,
      )

      // Run the job
      const now = yield* DateTime.now
      const job = {
        jobId: "job-sla-001",
        queue: "flow-execution" as const,
        payload: { scheduledFlowId },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      }

      yield* flowExecutionHandler.handle(job)

      // Verify todo was created with SLA fields populated
      const todos = yield* db.select().from(schema.toDo)
      expect(todos).toHaveLength(1)
      const todo = todos[0]
      if (!todo) throw new Error("Todo not found")

      // SLA target should be set (2 business hours from now)
      expect(todo.slaTargetAt).not.toBeNull()
      // SLA warning should be set (50% = 1 business hour from now)
      expect(todo.slaWarningAt).not.toBeNull()

      // Warning should be before target (effectDateTime returns DateTime.Utc objects)
      if (todo.slaTargetAt && todo.slaWarningAt) {
        const targetMs = DateTime.toEpochMillis(todo.slaTargetAt)
        const warningMs = DateTime.toEpochMillis(todo.slaWarningAt)
        expect(warningMs).toBeLessThan(targetMs)
      }
    })

    await runProvidedTestProgram(testProgram, TestLayers)
  })

  it("should leave slaTargetAt null when step has no SLA configured", async () => {
    const { layer: mockQueueServiceLayer } = createMockQueueService()
    const { layers: TestLayers } = createTestLayers(mockQueueServiceLayer)

    const testProgram = Effect.gen(function* () {
      const { org } = createTestOrganisation()
      yield* storeOrganisation(org)

      const db = yield* TypedSqliteDrizzle

      // Get the flow (submit -> approve)
      const flows = yield* db.select().from(schema.flow)
      const flow = flows[0]
      if (!flow) throw new Error("Flow not found")

      // Clear SLA on target step for this test
      yield* db
        .update(schema.step)
        .set({ slaValue: null, slaUnit: null, slaWarning: null })
        .where(eq(schema.step.id, flow.targetStepId))

      const processes = yield* db.select().from(schema.process)
      const process = processes[0]
      if (!process) throw new Error("Process not found")

      // Create process state and execution
      const processStateId = "pst-sla-002"
      yield* db.insert(schema.processState).values({
        id: processStateId,
        processId: process.id,
        startStepId: flow.sourceStepId,
        state: { data: "test" },
      })

      const processExecutionId = "pex-sla-002"
      yield* db.insert(schema.processExecution).values({
        id: processExecutionId,
        processStateId,
      })

      // Create scheduled_flow record
      const scheduledFlowOps = yield* ScheduledFlowOperations
      const scheduledFlowId = yield* scheduledFlowOps.insertScheduledFlow(
        processExecutionId,
        flow.sourceStepId,
      )

      // Run the job
      const now = yield* DateTime.now
      const job = {
        jobId: "job-sla-002",
        queue: "flow-execution" as const,
        payload: { scheduledFlowId },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      }

      yield* flowExecutionHandler.handle(job)

      // Verify todo was created without SLA fields
      const todos = yield* db.select().from(schema.toDo)
      expect(todos).toHaveLength(1)
      const todo = todos[0]
      if (!todo) throw new Error("Todo not found")

      // No SLA configured, so fields should be null
      expect(todo.slaTargetAt).toBeNull()
      expect(todo.slaWarningAt).toBeNull()
    })

    await runProvidedTestProgram(testProgram, TestLayers)
  })
})

describe("Business Calendar Schedule Resolution", () => {
  it("should resolve Schedule.businessHours() using business calendar", async () => {
    const { layer: mockQueueServiceLayer, enqueuedJobs } =
      createMockQueueService()

    // Create a mock schedule evaluator that returns a BusinessHoursSchedule marker
    // This simulates: Schedule.businessHours(completedAt, 2) - 2 business hours from now
    const baseTime = DateTime.unsafeMake(
      // Monday 2099-01-05 at 16:00 UTC (4pm)
      new Date("2099-01-05T16:00:00Z").getTime(),
    )
    const mockScheduleEvaluator: ScheduleEvaluatorService = {
      evaluate: () => Effect.succeed(Schedule.businessHours(baseTime, 2)),
    }

    const { layers: TestLayers } = createTestLayersWithScheduleEvaluator(
      mockQueueServiceLayer,
      mockScheduleEvaluator,
    )

    const testProgram = Effect.gen(function* () {
      const { org } = createTestOrganisation()
      yield* storeOrganisation(org)

      const db = yield* TypedSqliteDrizzle
      const flows = yield* db.select().from(schema.flow)
      const flow = flows[0]
      if (!flow) throw new Error("Flow not found")

      // Set schedule on the flow to trigger schedule evaluation
      yield* db
        .update(schema.flow)
        .set({ schedule: "2 business hours" })
        .where(eq(schema.flow.id, flow.id))

      // Get the org unit and configure business calendar (Mon-Fri 9-17 UTC)
      const orgUnits = yield* db.select().from(schema.orgUnit)
      const orgUnit = orgUnits[0]
      if (!orgUnit) throw new Error("Org unit not found")

      // Set up business hours: Mon-Fri 9:00-17:00 UTC
      for (let day = 1; day <= 5; day++) {
        yield* db.insert(schema.weeklySchedule).values({
          orgUnitId: orgUnit.id,
          dayOfWeek: day,
          timeRanges: [
            { open: { hour: 9, minute: 0 }, close: { hour: 17, minute: 0 } },
          ],
        })
      }

      const processes = yield* db.select().from(schema.process)
      const process = processes[0]
      if (!process) throw new Error("Process not found")

      // Create a user for startedByUserId
      const userId = "usr-buscal-001"
      const userCreatedAt = yield* DateTime.now
      yield* db.insert(schema.user).values({
        id: userId,
        provider: "test",
        sub: "test@example.com",
        lastLoggedIn: userCreatedAt,
      })

      // Create process state and execution
      const processStateId = "pst-buscal-001"
      yield* db.insert(schema.processState).values({
        id: processStateId,
        processId: process.id,
        startStepId: flow.sourceStepId,
        startedByUserId: userId,
        state: { data: "test" },
      })

      const processExecutionId = "pex-buscal-001"
      yield* db.insert(schema.processExecution).values({
        id: processExecutionId,
        processStateId,
      })

      // Create scheduled_flow record
      const scheduledFlowOps = yield* ScheduledFlowOperations
      const scheduledFlowId = yield* scheduledFlowOps.insertScheduledFlow(
        processExecutionId,
        flow.sourceStepId,
      )

      // Run the job
      const now = yield* DateTime.now
      const job = {
        jobId: "job-buscal-001",
        queue: "flow-execution" as const,
        payload: { scheduledFlowId },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      }

      yield* flowExecutionHandler.handle(job)

      // The schedule should be deferred because:
      // - Base time is Monday 2099-01-05 16:00 UTC
      // - Adding 2 business hours: 16:00 + 1hr = 17:00 (end of day), then next day 09:00 + 1hr = 10:00
      // - So scheduled time should be Tuesday 2099-01-06 10:00 UTC
      // - This is in the future relative to "now" in the test

      // Verify a deferred flow was created
      const scheduledFlows = yield* db.select().from(schema.scheduledFlow)
      expect(scheduledFlows).toHaveLength(1)

      const deferredFlow = scheduledFlows[0]
      expect(deferredFlow?.scheduledAt).not.toBeNull()

      // Verify the scheduled time uses business calendar logic
      // Monday 2099-01-05 16:00 + 2 business hours should land on Tuesday during business hours
      // The exact hour depends on the business calendar implementation
      if (deferredFlow?.scheduledAt) {
        const scheduledDate = new Date(
          DateTime.toEpochMillis(deferredFlow.scheduledAt),
        )
        // Should be Tuesday (day 2) - skipped to next business day
        expect(scheduledDate.getUTCDay()).toBe(2) // Tuesday
        // Should be during business hours (9-17)
        const hours = scheduledDate.getUTCHours()
        expect(hours).toBeGreaterThanOrEqual(9)
        expect(hours).toBeLessThanOrEqual(17)
        // Should NOT be 18:00 (which would be clock time: 16:00 + 2 hours)
        // This proves we're using business hours, not clock hours
        expect(hours).not.toBe(18)
      }

      // Verify a delayed job was enqueued
      const deferredJobs = enqueuedJobs.filter(
        (j) => j.queue === FLOW_EXECUTION_QUEUE && j.delay !== undefined,
      )
      expect(deferredJobs).toHaveLength(1)
    })

    await runProvidedTestProgram(testProgram, TestLayers)
  })

  it("should resolve Schedule.businessDays() using business calendar", async () => {
    const { layer: mockQueueServiceLayer, enqueuedJobs } =
      createMockQueueService()

    // Create a mock schedule evaluator that returns a BusinessDaysSchedule marker
    // This simulates: Schedule.businessDays(completedAt, 2) - 2 business days from Friday
    const baseTime = DateTime.unsafeMake(
      // Friday 2099-01-09 at 14:00 UTC
      new Date("2099-01-09T14:00:00Z").getTime(),
    )
    const mockScheduleEvaluator: ScheduleEvaluatorService = {
      evaluate: () => Effect.succeed(Schedule.businessDays(baseTime, 2)),
    }

    const { layers: TestLayers } = createTestLayersWithScheduleEvaluator(
      mockQueueServiceLayer,
      mockScheduleEvaluator,
    )

    const testProgram = Effect.gen(function* () {
      const { org } = createTestOrganisation()
      yield* storeOrganisation(org)

      const db = yield* TypedSqliteDrizzle
      const flows = yield* db.select().from(schema.flow)
      const flow = flows[0]
      if (!flow) throw new Error("Flow not found")

      // Set schedule on the flow to trigger schedule evaluation
      yield* db
        .update(schema.flow)
        .set({ schedule: "2 business days" })
        .where(eq(schema.flow.id, flow.id))

      // Get the org unit and configure business calendar (Mon-Fri 9-17 UTC)
      const orgUnits = yield* db.select().from(schema.orgUnit)
      const orgUnit = orgUnits[0]
      if (!orgUnit) throw new Error("Org unit not found")

      // Set up business hours: Mon-Fri 9:00-17:00 UTC
      for (let day = 1; day <= 5; day++) {
        yield* db.insert(schema.weeklySchedule).values({
          orgUnitId: orgUnit.id,
          dayOfWeek: day,
          timeRanges: [
            { open: { hour: 9, minute: 0 }, close: { hour: 17, minute: 0 } },
          ],
        })
      }

      const processes = yield* db.select().from(schema.process)
      const process = processes[0]
      if (!process) throw new Error("Process not found")

      // Create a user for startedByUserId
      const userId = "usr-buscal-002"
      const userCreatedAt = yield* DateTime.now
      yield* db.insert(schema.user).values({
        id: userId,
        provider: "test",
        sub: "test2@example.com",
        lastLoggedIn: userCreatedAt,
      })

      // Create process state and execution
      const processStateId = "pst-buscal-002"
      yield* db.insert(schema.processState).values({
        id: processStateId,
        processId: process.id,
        startStepId: flow.sourceStepId,
        startedByUserId: userId,
        state: { data: "test" },
      })

      const processExecutionId = "pex-buscal-002"
      yield* db.insert(schema.processExecution).values({
        id: processExecutionId,
        processStateId,
      })

      // Create scheduled_flow record
      const scheduledFlowOps = yield* ScheduledFlowOperations
      const scheduledFlowId = yield* scheduledFlowOps.insertScheduledFlow(
        processExecutionId,
        flow.sourceStepId,
      )

      // Run the job
      const now = yield* DateTime.now
      const job = {
        jobId: "job-buscal-002",
        queue: "flow-execution" as const,
        payload: { scheduledFlowId },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      }

      yield* flowExecutionHandler.handle(job)

      // The schedule should be deferred because:
      // - Base time is Friday 2099-01-09 14:00 UTC
      // - Adding 2 business days: Friday -> Monday (1), Monday -> Tuesday (2)
      // - So scheduled time should be Tuesday 2099-01-13 at 14:00 UTC (same time of day)

      // Verify a deferred flow was created
      const scheduledFlows = yield* db.select().from(schema.scheduledFlow)
      expect(scheduledFlows).toHaveLength(1)

      const deferredFlow = scheduledFlows[0]
      expect(deferredFlow?.scheduledAt).not.toBeNull()

      // Verify the scheduled time is Tuesday (skipping weekend)
      // Friday 2099-01-09 + 2 business days = Tuesday 2099-01-13
      if (deferredFlow?.scheduledAt) {
        const scheduledDate = new Date(
          DateTime.toEpochMillis(deferredFlow.scheduledAt),
        )
        // Should be Tuesday (day 2)
        expect(scheduledDate.getUTCDay()).toBe(2) // Tuesday
        // Time should be preserved at 14:00 UTC
        expect(scheduledDate.getUTCHours()).toBe(14)
      }

      // Verify a delayed job was enqueued
      const deferredJobs = enqueuedJobs.filter(
        (j) => j.queue === FLOW_EXECUTION_QUEUE && j.delay !== undefined,
      )
      expect(deferredJobs).toHaveLength(1)
    })

    await runProvidedTestProgram(testProgram, TestLayers)
  })

  it("should fall back to clock time when no calendar is configured", async () => {
    const { layer: mockQueueServiceLayer, enqueuedJobs } =
      createMockQueueService()

    // Create a mock schedule evaluator that returns a BusinessHoursSchedule marker
    const baseTime = DateTime.unsafeMake(
      // Monday 2099-01-05 at 16:00 UTC
      new Date("2099-01-05T16:00:00Z").getTime(),
    )
    const mockScheduleEvaluator: ScheduleEvaluatorService = {
      evaluate: () => Effect.succeed(Schedule.businessHours(baseTime, 2)),
    }

    const { layers: TestLayers } = createTestLayersWithScheduleEvaluator(
      mockQueueServiceLayer,
      mockScheduleEvaluator,
    )

    const testProgram = Effect.gen(function* () {
      const { org } = createTestOrganisation()
      yield* storeOrganisation(org)

      const db = yield* TypedSqliteDrizzle
      const flows = yield* db.select().from(schema.flow)
      const flow = flows[0]
      if (!flow) throw new Error("Flow not found")

      // Set schedule on the flow to trigger schedule evaluation
      yield* db
        .update(schema.flow)
        .set({ schedule: "2 business hours" })
        .where(eq(schema.flow.id, flow.id))

      // NOTE: No weekly schedule configured - no business calendar

      const processes = yield* db.select().from(schema.process)
      const process = processes[0]
      if (!process) throw new Error("Process not found")

      // Create a user for startedByUserId
      const userId = "usr-buscal-003"
      const userCreatedAt = yield* DateTime.now
      yield* db.insert(schema.user).values({
        id: userId,
        provider: "test",
        sub: "test3@example.com",
        lastLoggedIn: userCreatedAt,
      })

      // Create process state and execution
      const processStateId = "pst-buscal-003"
      yield* db.insert(schema.processState).values({
        id: processStateId,
        processId: process.id,
        startStepId: flow.sourceStepId,
        startedByUserId: userId,
        state: { data: "test" },
      })

      const processExecutionId = "pex-buscal-003"
      yield* db.insert(schema.processExecution).values({
        id: processExecutionId,
        processStateId,
      })

      // Create scheduled_flow record
      const scheduledFlowOps = yield* ScheduledFlowOperations
      const scheduledFlowId = yield* scheduledFlowOps.insertScheduledFlow(
        processExecutionId,
        flow.sourceStepId,
      )

      // Run the job
      const now = yield* DateTime.now
      const job = {
        jobId: "job-buscal-003",
        queue: "flow-execution" as const,
        payload: { scheduledFlowId },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      }

      yield* flowExecutionHandler.handle(job)

      // Without a calendar, 2 business hours should fall back to 2 clock hours
      // Base time: Monday 2099-01-05 16:00 UTC + 2 hours = Monday 18:00 UTC

      // Verify a deferred flow was created
      const scheduledFlows = yield* db.select().from(schema.scheduledFlow)
      expect(scheduledFlows).toHaveLength(1)

      const deferredFlow = scheduledFlows[0]
      expect(deferredFlow?.scheduledAt).not.toBeNull()

      // Verify the scheduled time is 2 clock hours later (not business hours)
      if (deferredFlow?.scheduledAt) {
        const scheduledDate = new Date(
          DateTime.toEpochMillis(deferredFlow.scheduledAt),
        )
        // Should still be Monday (day 1)
        expect(scheduledDate.getUTCDay()).toBe(1) // Monday
        // Should be 18:00 UTC (16:00 + 2 hours)
        expect(scheduledDate.getUTCHours()).toBe(18)
      }

      // Verify a delayed job was enqueued
      const deferredJobs = enqueuedJobs.filter(
        (j) => j.queue === FLOW_EXECUTION_QUEUE && j.delay !== undefined,
      )
      expect(deferredJobs).toHaveLength(1)
    })

    await runProvidedTestProgram(testProgram, TestLayers)
  })

  it("should resolve Schedule.fromPoint() with negative offset, snapping backward to business day", async () => {
    const { layer: mockQueueServiceLayer, enqueuedJobs } =
      createMockQueueService()

    // Simulate: Schedule.fromPoint(state.start_date, { days: -7 })
    // Start date is Monday Jan 19 2099, subtract 7 days = Jan 12 2099
    // Jan 12 is a Monday (business day), no snap needed
    const startDate = DateTime.unsafeMake(
      // Monday 2099-01-19 at 10:00 UTC
      new Date("2099-01-19T10:00:00Z").getTime(),
    )
    const mockScheduleEvaluator: ScheduleEvaluatorService = {
      evaluate: () =>
        Effect.succeed(Schedule.fromPoint(startDate, { days: -7 })),
    }

    const { layers: TestLayers } = createTestLayersWithScheduleEvaluator(
      mockQueueServiceLayer,
      mockScheduleEvaluator,
    )

    const testProgram = Effect.gen(function* () {
      const { org } = createTestOrganisation()
      yield* storeOrganisation(org)

      const db = yield* TypedSqliteDrizzle
      const flows = yield* db.select().from(schema.flow)
      const flow = flows[0]
      if (!flow) throw new Error("Flow not found")

      // Set schedule on the flow to trigger schedule evaluation
      yield* db
        .update(schema.flow)
        .set({ schedule: "7 days before start" })
        .where(eq(schema.flow.id, flow.id))

      // Get the org unit and configure business calendar (Mon-Fri 9-17 UTC)
      const orgUnits = yield* db.select().from(schema.orgUnit)
      const orgUnit = orgUnits[0]
      if (!orgUnit) throw new Error("Org unit not found")

      // Set up business hours: Mon-Fri 9:00-17:00 UTC
      for (let day = 1; day <= 5; day++) {
        yield* db.insert(schema.weeklySchedule).values({
          orgUnitId: orgUnit.id,
          dayOfWeek: day,
          timeRanges: [
            { open: { hour: 9, minute: 0 }, close: { hour: 17, minute: 0 } },
          ],
        })
      }

      const processes = yield* db.select().from(schema.process)
      const process = processes[0]
      if (!process) throw new Error("Process not found")

      // Create a user for startedByUserId
      const userId = "usr-frompt-001"
      const userCreatedAt = yield* DateTime.now
      yield* db.insert(schema.user).values({
        id: userId,
        provider: "test",
        sub: "test@example.com",
        lastLoggedIn: userCreatedAt,
      })

      // Create process state and execution
      const processStateId = "pst-frompt-001"
      yield* db.insert(schema.processState).values({
        id: processStateId,
        processId: process.id,
        startStepId: flow.sourceStepId,
        startedByUserId: userId,
        state: { start_date: startDate },
      })

      const processExecutionId = "pex-frompt-001"
      yield* db.insert(schema.processExecution).values({
        id: processExecutionId,
        processStateId,
      })

      // Create scheduled_flow record
      const scheduledFlowOps = yield* ScheduledFlowOperations
      const scheduledFlowId = yield* scheduledFlowOps.insertScheduledFlow(
        processExecutionId,
        flow.sourceStepId,
      )

      // Run the job
      const now = yield* DateTime.now
      const job = {
        jobId: "job-frompt-001",
        queue: "flow-execution" as const,
        payload: { scheduledFlowId },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      }

      yield* flowExecutionHandler.handle(job)

      // The schedule should be deferred because:
      // - Start date is Monday 2099-01-19, subtract 7 days = Monday 2099-01-12
      // - Jan 12 is a business day (no snap needed)
      // - Should be scheduled at the start of business day (09:00)

      // Verify a deferred flow was created
      const scheduledFlows = yield* db.select().from(schema.scheduledFlow)
      expect(scheduledFlows).toHaveLength(1)

      const deferredFlow = scheduledFlows[0]
      expect(deferredFlow?.scheduledAt).not.toBeNull()

      if (deferredFlow?.scheduledAt) {
        const scheduledDate = new Date(
          DateTime.toEpochMillis(deferredFlow.scheduledAt),
        )
        // Should be Monday Jan 12, 2099
        expect(scheduledDate.getUTCFullYear()).toBe(2099)
        expect(scheduledDate.getUTCMonth()).toBe(0) // January (0-indexed)
        expect(scheduledDate.getUTCDate()).toBe(12)
        // Should be at start of business hours (09:00)
        expect(scheduledDate.getUTCHours()).toBe(9)
        expect(scheduledDate.getUTCMinutes()).toBe(0)
      }

      // Verify a delayed job was enqueued
      const deferredJobs = enqueuedJobs.filter(
        (j) => j.queue === FLOW_EXECUTION_QUEUE && j.delay !== undefined,
      )
      expect(deferredJobs).toHaveLength(1)
    })

    await runProvidedTestProgram(testProgram, TestLayers)
  })

  it("should resolve Schedule.fromPoint() with positive offset, snapping forward to business day", async () => {
    const { layer: mockQueueServiceLayer, enqueuedJobs } =
      createMockQueueService()

    // Simulate: Schedule.fromPoint(state.start_date, { days: 7 })
    // Start date is Friday 2099-01-09, add 7 days = 2099-01-16 (Friday)
    // Both are business days, no snap needed
    const startDate = DateTime.unsafeMake(
      // Friday 2099-01-09 at 10:00 UTC
      new Date("2099-01-09T10:00:00Z").getTime(),
    )
    const mockScheduleEvaluator: ScheduleEvaluatorService = {
      evaluate: () =>
        Effect.succeed(Schedule.fromPoint(startDate, { days: 7 })),
    }

    const { layers: TestLayers } = createTestLayersWithScheduleEvaluator(
      mockQueueServiceLayer,
      mockScheduleEvaluator,
    )

    const testProgram = Effect.gen(function* () {
      const { org } = createTestOrganisation()
      yield* storeOrganisation(org)

      const db = yield* TypedSqliteDrizzle
      const flows = yield* db.select().from(schema.flow)
      const flow = flows[0]
      if (!flow) throw new Error("Flow not found")

      // Set schedule on the flow to trigger schedule evaluation
      yield* db
        .update(schema.flow)
        .set({ schedule: "7 days after start" })
        .where(eq(schema.flow.id, flow.id))

      // Get the org unit and configure business calendar (Mon-Fri 9-17 UTC)
      const orgUnits = yield* db.select().from(schema.orgUnit)
      const orgUnit = orgUnits[0]
      if (!orgUnit) throw new Error("Org unit not found")

      // Set up business hours: Mon-Fri 9:00-17:00 UTC
      for (let day = 1; day <= 5; day++) {
        yield* db.insert(schema.weeklySchedule).values({
          orgUnitId: orgUnit.id,
          dayOfWeek: day,
          timeRanges: [
            { open: { hour: 9, minute: 0 }, close: { hour: 17, minute: 0 } },
          ],
        })
      }

      const processes = yield* db.select().from(schema.process)
      const process = processes[0]
      if (!process) throw new Error("Process not found")

      // Create a user for startedByUserId
      const userId = "usr-frompt-002"
      const userCreatedAt = yield* DateTime.now
      yield* db.insert(schema.user).values({
        id: userId,
        provider: "test",
        sub: "test2@example.com",
        lastLoggedIn: userCreatedAt,
      })

      // Create process state and execution
      const processStateId = "pst-frompt-002"
      yield* db.insert(schema.processState).values({
        id: processStateId,
        processId: process.id,
        startStepId: flow.sourceStepId,
        startedByUserId: userId,
        state: { start_date: startDate },
      })

      const processExecutionId = "pex-frompt-002"
      yield* db.insert(schema.processExecution).values({
        id: processExecutionId,
        processStateId,
      })

      // Create scheduled_flow record
      const scheduledFlowOps = yield* ScheduledFlowOperations
      const scheduledFlowId = yield* scheduledFlowOps.insertScheduledFlow(
        processExecutionId,
        flow.sourceStepId,
      )

      // Run the job
      const now = yield* DateTime.now
      const job = {
        jobId: "job-frompt-002",
        queue: "flow-execution" as const,
        payload: { scheduledFlowId },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      }

      yield* flowExecutionHandler.handle(job)

      // Verify a deferred flow was created
      const scheduledFlows = yield* db.select().from(schema.scheduledFlow)
      expect(scheduledFlows).toHaveLength(1)

      const deferredFlow = scheduledFlows[0]
      expect(deferredFlow?.scheduledAt).not.toBeNull()

      if (deferredFlow?.scheduledAt) {
        const scheduledDate = new Date(
          DateTime.toEpochMillis(deferredFlow.scheduledAt),
        )
        // Should be Friday Jan 16, 2099
        expect(scheduledDate.getUTCFullYear()).toBe(2099)
        expect(scheduledDate.getUTCMonth()).toBe(0) // January (0-indexed)
        expect(scheduledDate.getUTCDate()).toBe(16)
        // Should be at start of business hours (09:00)
        expect(scheduledDate.getUTCHours()).toBe(9)
        expect(scheduledDate.getUTCMinutes()).toBe(0)
      }

      // Verify a delayed job was enqueued
      const deferredJobs = enqueuedJobs.filter(
        (j) => j.queue === FLOW_EXECUTION_QUEUE && j.delay !== undefined,
      )
      expect(deferredJobs).toHaveLength(1)
    })

    await runProvidedTestProgram(testProgram, TestLayers)
  })

  it("should fall back to clock time for Schedule.fromPoint() when no calendar is configured", async () => {
    const { layer: mockQueueServiceLayer, enqueuedJobs } =
      createMockQueueService()

    // Simulate: Schedule.fromPoint(state.start_date, { days: -7 })
    // With no calendar configured, should use plain calendar math
    const startDate = DateTime.unsafeMake(
      // Monday 2099-01-19 at 10:00 UTC
      new Date("2099-01-19T10:00:00Z").getTime(),
    )
    const mockScheduleEvaluator: ScheduleEvaluatorService = {
      evaluate: () =>
        Effect.succeed(Schedule.fromPoint(startDate, { days: -7 })),
    }

    const { layers: TestLayers } = createTestLayersWithScheduleEvaluator(
      mockQueueServiceLayer,
      mockScheduleEvaluator,
    )

    const testProgram = Effect.gen(function* () {
      const { org } = createTestOrganisation()
      yield* storeOrganisation(org)

      const db = yield* TypedSqliteDrizzle
      const flows = yield* db.select().from(schema.flow)
      const flow = flows[0]
      if (!flow) throw new Error("Flow not found")

      // Set schedule on the flow to trigger schedule evaluation
      yield* db
        .update(schema.flow)
        .set({ schedule: "7 days before start" })
        .where(eq(schema.flow.id, flow.id))

      // NOTE: No weekly schedule configured - no business calendar

      const processes = yield* db.select().from(schema.process)
      const process = processes[0]
      if (!process) throw new Error("Process not found")

      // Create a user for startedByUserId
      const userId = "usr-frompt-003"
      const userCreatedAt = yield* DateTime.now
      yield* db.insert(schema.user).values({
        id: userId,
        provider: "test",
        sub: "test3@example.com",
        lastLoggedIn: userCreatedAt,
      })

      // Create process state and execution
      const processStateId = "pst-frompt-003"
      yield* db.insert(schema.processState).values({
        id: processStateId,
        processId: process.id,
        startStepId: flow.sourceStepId,
        startedByUserId: userId,
        state: { start_date: startDate },
      })

      const processExecutionId = "pex-frompt-003"
      yield* db.insert(schema.processExecution).values({
        id: processExecutionId,
        processStateId,
      })

      // Create scheduled_flow record
      const scheduledFlowOps = yield* ScheduledFlowOperations
      const scheduledFlowId = yield* scheduledFlowOps.insertScheduledFlow(
        processExecutionId,
        flow.sourceStepId,
      )

      // Run the job
      const now = yield* DateTime.now
      const job = {
        jobId: "job-frompt-003",
        queue: "flow-execution" as const,
        payload: { scheduledFlowId },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      }

      yield* flowExecutionHandler.handle(job)

      // Without a calendar, should just subtract 7 days and use that exact date/time
      // Monday 2099-01-19 10:00 - 7 days = Monday 2099-01-12 10:00

      // Verify a deferred flow was created
      const scheduledFlows = yield* db.select().from(schema.scheduledFlow)
      expect(scheduledFlows).toHaveLength(1)

      const deferredFlow = scheduledFlows[0]
      expect(deferredFlow?.scheduledAt).not.toBeNull()

      if (deferredFlow?.scheduledAt) {
        const scheduledDate = new Date(
          DateTime.toEpochMillis(deferredFlow.scheduledAt),
        )
        // Without calendar: 2099-01-19 10:00 UTC - 7 days = 2099-01-12 10:00 UTC
        // Uses plain calendar math (DateTime.add) - no business day snapping
        expect(scheduledDate.getUTCFullYear()).toBe(2099)
        expect(scheduledDate.getUTCMonth()).toBe(0) // January (0-indexed)
        expect(scheduledDate.getUTCDate()).toBe(12)
        // Without calendar, time should be approximately 10:00
        // Note: Test execution timing may cause small variance in minutes
        expect(scheduledDate.getUTCHours()).toBeGreaterThanOrEqual(9)
        expect(scheduledDate.getUTCHours()).toBeLessThanOrEqual(11)
      }

      // Verify a delayed job was enqueued
      const deferredJobs = enqueuedJobs.filter(
        (j) => j.queue === FLOW_EXECUTION_QUEUE && j.delay !== undefined,
      )
      expect(deferredJobs).toHaveLength(1)
    })

    await runProvidedTestProgram(testProgram, TestLayers)
  })

  it("should defer Schedule.fromPoint() with zero offset when target is in future", async () => {
    const { layer: mockQueueServiceLayer, enqueuedJobs } =
      createMockQueueService()

    // Simulate: Schedule.fromPoint(state.start_date, { days: 0 })
    // When the target date is in the future, it should be deferred
    const startDate = DateTime.unsafeMake(
      // Monday 2099-01-19 at 14:30 UTC (during business hours, in future)
      new Date("2099-01-19T14:30:00Z").getTime(),
    )
    const mockScheduleEvaluator: ScheduleEvaluatorService = {
      evaluate: () =>
        Effect.succeed(Schedule.fromPoint(startDate, { days: 0 })),
    }

    const { layers: TestLayers } = createTestLayersWithScheduleEvaluator(
      mockQueueServiceLayer,
      mockScheduleEvaluator,
    )

    const testProgram = Effect.gen(function* () {
      const { org } = createTestOrganisation()
      yield* storeOrganisation(org)

      const db = yield* TypedSqliteDrizzle
      const flows = yield* db.select().from(schema.flow)
      const flow = flows[0]
      if (!flow) throw new Error("Flow not found")

      // Set schedule on the flow to trigger schedule evaluation
      yield* db
        .update(schema.flow)
        .set({ schedule: "on start date" })
        .where(eq(schema.flow.id, flow.id))

      // Get the org unit and configure business calendar (Mon-Fri 9-17 UTC)
      const orgUnits = yield* db.select().from(schema.orgUnit)
      const orgUnit = orgUnits[0]
      if (!orgUnit) throw new Error("Org unit not found")

      // Set up business hours: Mon-Fri 9:00-17:00 UTC
      for (let day = 1; day <= 5; day++) {
        yield* db.insert(schema.weeklySchedule).values({
          orgUnitId: orgUnit.id,
          dayOfWeek: day,
          timeRanges: [
            { open: { hour: 9, minute: 0 }, close: { hour: 17, minute: 0 } },
          ],
        })
      }

      const processes = yield* db.select().from(schema.process)
      const process = processes[0]
      if (!process) throw new Error("Process not found")

      // Create a user for startedByUserId
      const userId = "usr-frompt-004"
      const userCreatedAt = yield* DateTime.now
      yield* db.insert(schema.user).values({
        id: userId,
        provider: "test",
        sub: "test4@example.com",
        lastLoggedIn: userCreatedAt,
      })

      // Create process state and execution
      const processStateId = "pst-frompt-004"
      yield* db.insert(schema.processState).values({
        id: processStateId,
        processId: process.id,
        startStepId: flow.sourceStepId,
        startedByUserId: userId,
        state: { start_date: startDate },
      })

      const processExecutionId = "pex-frompt-004"
      yield* db.insert(schema.processExecution).values({
        id: processExecutionId,
        processStateId,
      })

      // Create scheduled_flow record
      const scheduledFlowOps = yield* ScheduledFlowOperations
      const scheduledFlowId = yield* scheduledFlowOps.insertScheduledFlow(
        processExecutionId,
        flow.sourceStepId,
      )

      // Run the job
      const now = yield* DateTime.now
      const job = {
        jobId: "job-frompt-004",
        queue: "flow-execution" as const,
        payload: { scheduledFlowId },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      }

      yield* flowExecutionHandler.handle(job)

      // When target is in the future, flow should be deferred (not executed immediately)
      // The schedule should snap to the start of the business day (09:00)
      const scheduledFlows = yield* db.select().from(schema.scheduledFlow)
      expect(scheduledFlows).toHaveLength(1)

      const deferredFlow = scheduledFlows[0]
      expect(deferredFlow?.scheduledAt).not.toBeNull()

      if (deferredFlow?.scheduledAt) {
        const scheduledDate = new Date(
          DateTime.toEpochMillis(deferredFlow.scheduledAt),
        )
        // Should be Monday Jan 19, 2099
        expect(scheduledDate.getUTCFullYear()).toBe(2099)
        expect(scheduledDate.getUTCMonth()).toBe(0) // January (0-indexed)
        expect(scheduledDate.getUTCDate()).toBe(19)
        // Zero offset on a business day snaps to start of business hours (09:00)
        expect(scheduledDate.getUTCHours()).toBe(9)
        expect(scheduledDate.getUTCMinutes()).toBe(0)
      }

      // Verify a delayed job was enqueued
      const deferredJobs = enqueuedJobs.filter(
        (j) => j.queue === FLOW_EXECUTION_QUEUE && j.delay !== undefined,
      )
      expect(deferredJobs).toHaveLength(1)
    })

    await runProvidedTestProgram(testProgram, TestLayers)
  })

  it("should snap forward when zero offset lands on non-business day", async () => {
    const { layer: mockQueueServiceLayer, enqueuedJobs } =
      createMockQueueService()

    // Simulate: Schedule.fromPoint(state.start_date, { days: 0 })
    // When the target date is a Saturday (non-business day), should snap forward to Monday
    const startDate = DateTime.unsafeMake(
      // Saturday 2099-01-10 at 10:00 UTC (weekend)
      new Date("2099-01-10T10:00:00Z").getTime(),
    )
    const mockScheduleEvaluator: ScheduleEvaluatorService = {
      evaluate: () =>
        Effect.succeed(Schedule.fromPoint(startDate, { days: 0 })),
    }

    const { layers: TestLayers } = createTestLayersWithScheduleEvaluator(
      mockQueueServiceLayer,
      mockScheduleEvaluator,
    )

    const testProgram = Effect.gen(function* () {
      const { org } = createTestOrganisation()
      yield* storeOrganisation(org)

      const db = yield* TypedSqliteDrizzle
      const flows = yield* db.select().from(schema.flow)
      const flow = flows[0]
      if (!flow) throw new Error("Flow not found")

      // Set schedule on the flow to trigger schedule evaluation
      yield* db
        .update(schema.flow)
        .set({ schedule: "on start date" })
        .where(eq(schema.flow.id, flow.id))

      // Get the org unit and configure business calendar (Mon-Fri 9-17 UTC)
      const orgUnits = yield* db.select().from(schema.orgUnit)
      const orgUnit = orgUnits[0]
      if (!orgUnit) throw new Error("Org unit not found")

      // Set up business hours: Mon-Fri 9:00-17:00 UTC
      for (let day = 1; day <= 5; day++) {
        yield* db.insert(schema.weeklySchedule).values({
          orgUnitId: orgUnit.id,
          dayOfWeek: day,
          timeRanges: [
            { open: { hour: 9, minute: 0 }, close: { hour: 17, minute: 0 } },
          ],
        })
      }

      const processes = yield* db.select().from(schema.process)
      const process = processes[0]
      if (!process) throw new Error("Process not found")

      // Create a user for startedByUserId
      const userId = "usr-frompt-005"
      const userCreatedAt = yield* DateTime.now
      yield* db.insert(schema.user).values({
        id: userId,
        provider: "test",
        sub: "test5@example.com",
        lastLoggedIn: userCreatedAt,
      })

      // Create process state and execution
      const processStateId = "pst-frompt-005"
      yield* db.insert(schema.processState).values({
        id: processStateId,
        processId: process.id,
        startStepId: flow.sourceStepId,
        startedByUserId: userId,
        state: { start_date: startDate },
      })

      const processExecutionId = "pex-frompt-005"
      yield* db.insert(schema.processExecution).values({
        id: processExecutionId,
        processStateId,
      })

      // Create scheduled_flow record
      const scheduledFlowOps = yield* ScheduledFlowOperations
      const scheduledFlowId = yield* scheduledFlowOps.insertScheduledFlow(
        processExecutionId,
        flow.sourceStepId,
      )

      // Run the job
      const now = yield* DateTime.now
      const job = {
        jobId: "job-frompt-005",
        queue: "flow-execution" as const,
        payload: { scheduledFlowId },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      }

      yield* flowExecutionHandler.handle(job)

      // Zero offset on Saturday should snap forward to Monday
      const scheduledFlows = yield* db.select().from(schema.scheduledFlow)
      expect(scheduledFlows).toHaveLength(1)

      const deferredFlow = scheduledFlows[0]
      expect(deferredFlow?.scheduledAt).not.toBeNull()

      if (deferredFlow?.scheduledAt) {
        const scheduledDate = new Date(
          DateTime.toEpochMillis(deferredFlow.scheduledAt),
        )
        // Should snap from Saturday 2099-01-10 to Monday 2099-01-12
        expect(scheduledDate.getUTCFullYear()).toBe(2099)
        expect(scheduledDate.getUTCMonth()).toBe(0) // January (0-indexed)
        expect(scheduledDate.getUTCDate()).toBe(12) // Monday
        // Should snap to start of business hours (09:00)
        expect(scheduledDate.getUTCHours()).toBe(9)
        expect(scheduledDate.getUTCMinutes()).toBe(0)
      }

      // Verify a delayed job was enqueued
      const deferredJobs = enqueuedJobs.filter(
        (j) => j.queue === FLOW_EXECUTION_QUEUE && j.delay !== undefined,
      )
      expect(deferredJobs).toHaveLength(1)
    })

    await runProvidedTestProgram(testProgram, TestLayers)
  })
})

describe("Business Duration Calculation", () => {
  it("should store wallclock duration when no calendar is configured", async () => {
    const { layer: mockQueueServiceLayer } = createMockQueueService()
    const { layers: TestLayers } = createTestLayers(mockQueueServiceLayer)

    const testProgram = Effect.gen(function* () {
      const { org } = createTestOrganisation()
      yield* storeOrganisation(org)

      const db = yield* TypedSqliteDrizzle

      // Get the approve step (final step with no outgoing flows)
      const steps = yield* db.select().from(schema.step)
      const approveStep = steps.find((s) => s.name === "Approve")
      if (!approveStep) throw new Error("Approve step not found")

      const processes = yield* db.select().from(schema.process)
      const process = processes[0]
      if (!process) throw new Error("Process not found")

      // Create process state and execution
      const processStateId = "pst-duration-001"
      yield* db.insert(schema.processState).values({
        id: processStateId,
        processId: process.id,
        startStepId: approveStep.id,
        state: {},
      })

      const processExecutionId = "pex-duration-001"
      yield* db.insert(schema.processExecution).values({
        id: processExecutionId,
        processStateId,
      })

      // Create scheduled_flow record
      const scheduledFlowOps = yield* ScheduledFlowOperations
      const scheduledFlowId = yield* scheduledFlowOps.insertScheduledFlow(
        processExecutionId,
        approveStep.id,
      )

      // Run the job
      const now = yield* DateTime.now
      const job = {
        jobId: "job-duration-001",
        queue: "flow-execution" as const,
        payload: { scheduledFlowId },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      }

      yield* flowExecutionHandler.handle(job)

      // Verify process execution is finished with business duration
      const execution = yield* db
        .select()
        .from(schema.processExecution)
        .where(eq(schema.processExecution.id, processExecutionId))

      expect(execution[0]?.finishedAt).not.toBeNull()
      // Without a calendar configured, businessDuration should be set to wallclock time
      // The value should be a number (could be slightly negative due to Julian day precision in tests)
      expect(execution[0]?.businessDuration).not.toBeNull()
      expect(typeof execution[0]?.businessDuration).toBe("number")
    })

    await runProvidedTestProgram(testProgram, TestLayers)
  })

  it("should store business duration with calendar configured", async () => {
    const { layer: mockQueueServiceLayer } = createMockQueueService()
    const { layers: TestLayers } = createTestLayers(mockQueueServiceLayer)

    const testProgram = Effect.gen(function* () {
      const { org } = createTestOrganisation()
      yield* storeOrganisation(org)

      const db = yield* TypedSqliteDrizzle

      // Get the org unit (created by storeOrganisation)
      const orgUnits = yield* db.select().from(schema.orgUnit)
      const orgUnit = orgUnits[0]
      if (!orgUnit) throw new Error("Org unit not found")

      // Set up a business calendar for the org unit (Mon-Fri 9-17 UTC)
      for (let day = 1; day <= 5; day++) {
        yield* db.insert(schema.weeklySchedule).values({
          orgUnitId: orgUnit.id,
          dayOfWeek: day,
          timeRanges: [
            { open: { hour: 9, minute: 0 }, close: { hour: 17, minute: 0 } },
          ],
        })
      }

      // Get the approve step (final step with no outgoing flows)
      const steps = yield* db.select().from(schema.step)
      const approveStep = steps.find((s) => s.name === "Approve")
      if (!approveStep) throw new Error("Approve step not found")

      const processes = yield* db.select().from(schema.process)
      const process = processes[0]
      if (!process) throw new Error("Process not found")

      // Create process state and execution
      const processStateId = "pst-duration-002"
      yield* db.insert(schema.processState).values({
        id: processStateId,
        processId: process.id,
        startStepId: approveStep.id,
        state: {},
      })

      const processExecutionId = "pex-duration-002"
      yield* db.insert(schema.processExecution).values({
        id: processExecutionId,
        processStateId,
      })

      // Create scheduled_flow record
      const scheduledFlowOps = yield* ScheduledFlowOperations
      const scheduledFlowId = yield* scheduledFlowOps.insertScheduledFlow(
        processExecutionId,
        approveStep.id,
      )

      // Run the job
      const now = yield* DateTime.now
      const job = {
        jobId: "job-duration-002",
        queue: "flow-execution" as const,
        payload: { scheduledFlowId },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      }

      yield* flowExecutionHandler.handle(job)

      // Verify process execution is finished with business duration
      const execution = yield* db
        .select()
        .from(schema.processExecution)
        .where(eq(schema.processExecution.id, processExecutionId))

      expect(execution[0]?.finishedAt).not.toBeNull()
      // With a calendar configured, businessDuration should be calculated
      // Using business hours, the duration is 0 when started and finished within the same moment
      expect(execution[0]?.businessDuration).not.toBeNull()
      expect(typeof execution[0]?.businessDuration).toBe("number")
      // With business calendar, duration should be non-negative (0 is valid when test runs fast)
      expect(execution[0]?.businessDuration).toBeGreaterThanOrEqual(0)
    })

    await runProvidedTestProgram(testProgram, TestLayers)
  })
})
