import { SqlClient } from "@effect/sql"
import { eq } from "drizzle-orm"
import { DateTime, Effect, FiberRef, Layer, Option, Schema } from "effect"
import * as schema from "@pf/drizzle-sqlite"
import {
  UserDetails,
  type UserDetailsValue,
  serializeNotificationPreferences,
} from "@pf/graphql-db-operations"
import {
  EXECUTION_EVENT_QUEUE,
  NOTIFICATION_DELIVERY_QUEUE,
  type NotificationDeliveryPayload,
  PROCESS_EVENT_QUEUE,
  TODO_EVENT_QUEUE,
  applyPublicCompletionDeliveryCallback,
} from "@pf/job-handler"
import { storeOrganisation } from "@pf/org-to-db"
import {
  ExecutionFailureNotifications,
  Form,
  Organisation,
  OrganisationProvider,
  Process,
  Role,
  normalizePath,
} from "@pf/process"
import { EnqueueError, QueueService } from "@pf/queue-service"
import { RequestTime } from "@pf/request-time"
import {
  DatabaseTest,
  TypedSqliteDrizzle,
} from "@pf/service-drizzle-sqlite/test"
import {
  SqliteDbOperationsLive,
  SqliteFlowExecutionOperationsLive,
  SqliteGraphqlDbOperationsLive,
} from "@pf/sqlite-operations"
import { describe, expect, it } from "bun:test"

interface EnqueuedJob {
  readonly queue: string
  readonly payload: unknown
  readonly logicalJobId?: string
}

const createMockQueueService = (options?: {
  readonly failFirstEnqueue?: boolean
  readonly failEnqueueAttempts?: readonly number[]
  readonly queueInTransaction?: boolean
}) => {
  const enqueuedJobs: EnqueuedJob[] = []
  let enqueueAttempts = 0
  const enqueueJob = (
    queue: string,
    payload: unknown,
    enqueueOptions?: { readonly logicalJobId?: string },
  ) =>
    Effect.gen(function* () {
      enqueueAttempts += 1
      if (
        (options?.failFirstEnqueue && enqueueAttempts === 1) ||
        options?.failEnqueueAttempts?.includes(enqueueAttempts)
      ) {
        return yield* Effect.fail(
          new EnqueueError({
            queue,
            message: "Simulated enqueue failure",
          }),
        )
      }

      enqueuedJobs.push({
        queue,
        payload,
        ...(enqueueOptions?.logicalJobId
          ? { logicalJobId: enqueueOptions.logicalJobId }
          : {}),
      })
      return `mock-job-${enqueuedJobs.length}`
    })

  const layer = Layer.succeed(QueueService, {
    queueInTransaction: options?.queueInTransaction ?? true,
    enqueue: enqueueJob,
    enqueueWithDelay: enqueueJob,
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

  return { enqueuedJobs, layer }
}

const createPublicCompletionOrg = (options?: {
  readonly correction?: boolean
}) => {
  const org = new Organisation({ name: "PublicCompletionDeliveryOrg" })
  const employee = new Role(org, "employee", { name: "Employee" })
  const oversight = new Role(org, "oversight", { name: "Oversight" })

  const process = new Process(org, "public-completion-delivery", {
    name: "Public Completion Delivery",
    purpose: "Test public completion delivery callbacks",
  })
  const submit = new Form(process, "submit", {
    name: "Submit",
    role: employee,
    form: () => ({}),
  })
  const review = new Form(process.start(submit), "review", {
    name: "External Review",
    role: employee,
    form: () => ({ response: Schema.String }),
    publicCompletion: {
      recipient: () => ({ email: "external@example.com" }),
      expiresAt: () => DateTime.unsafeMake("2099-01-01T10:00:00.000Z"),
      ...(options?.correction === true
        ? {
            correction: {
              enabled: true as const,
              applyEmail: (_state, correctedEmail) => ({ correctedEmail }),
            },
          }
        : {}),
    },
  })
  submit.end(review)
  new ExecutionFailureNotifications(org, { roles: [oversight] })

  return { employee, org, oversight }
}

const createTestLayers = (
  org: Organisation,
  queueOptions?: {
    readonly failFirstEnqueue?: boolean
    readonly failEnqueueAttempts?: readonly number[]
    readonly queueInTransaction?: boolean
  },
) => {
  const { enqueuedJobs, layer: queueLayer } =
    createMockQueueService(queueOptions)
  const OrganisationProviderLive = Layer.succeed(OrganisationProvider, {
    organisation: org,
    orgPath: "/test-org",
    schemaPath: "/test-org/org.graphql",
    customGraphqlSchema: undefined,
  })
  const RequestTimeLive = Layer.succeed(
    RequestTime,
    FiberRef.unsafeMake(DateTime.unsafeMake("2026-06-01T10:00:00.000Z")),
  )
  const UserDetailsLive = Layer.succeed(
    UserDetails,
    FiberRef.unsafeMake({
      by: "TEST_USER",
      id: "TEST_USER",
    }) as FiberRef.FiberRef<UserDetailsValue>,
  )
  const BaseDbLayer = Layer.provideMerge(SqliteDbOperationsLive, DatabaseTest)
  const OperationLayers = Layer.provideMerge(
    Layer.mergeAll(
      SqliteFlowExecutionOperationsLive,
      SqliteGraphqlDbOperationsLive,
    ),
    BaseDbLayer,
  )
  const layers = Layer.mergeAll(
    OrganisationProviderLive,
    RequestTimeLive,
    UserDetailsLive,
    queueLayer,
    OperationLayers,
    BaseDbLayer,
  )

  return { enqueuedJobs, layers }
}

const roleIdByPath = (rolePath: string) =>
  Effect.gen(function* () {
    const db = yield* TypedSqliteDrizzle
    const rows = yield* db
      .select({ id: schema.role.id })
      .from(schema.role)
      .where(eq(schema.role.path, rolePath))
      .limit(1)
    const row = rows[0]
    if (!row) throw new Error(`Role not found: ${rolePath}`)
    return row.id
  })

const insertProviderUser = (params: {
  readonly userId: string
  readonly providerUserId: string
  readonly roleIds: readonly string[]
  readonly email: string
  readonly name: string
  readonly executionFailureEmailEnabled: boolean
}) =>
  Effect.gen(function* () {
    const db = yield* TypedSqliteDrizzle
    const now = yield* DateTime.now
    const orgUnit = (yield* db.select().from(schema.orgUnit))[0]
    if (!orgUnit) throw new Error("Org unit not found")

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

    yield* db.insert(schema.providerUserRole).values(
      params.roleIds.map((roleId, index) => ({
        id: `pur-${params.providerUserId}-${index}`,
        providerUserId: params.providerUserId,
        roleId,
      })),
    )

    yield* db.insert(schema.userSettings).values({
      id: `us-${params.userId}`,
      userId: params.userId,
      notificationPreference: serializeNotificationPreferences({
        notifications: {
          todoAssignment: { email: false },
          executionFailure: { email: params.executionFailureEmailEnabled },
        },
      }),
    })
  })

const insertWaitingPublicCompletion = (params?: {
  readonly oldAttemptId?: string
  readonly latestAttemptId?: string
}) =>
  Effect.gen(function* () {
    const db = yield* TypedSqliteDrizzle
    const flow = (yield* db.select().from(schema.flow))[0]
    const process = (yield* db.select().from(schema.process))[0]
    if (!flow) throw new Error("Flow not found")
    if (!process) throw new Error("Process not found")

    const processStateId = "pst-public-completion-delivery"
    const processExecutionId = "pex-public-completion-delivery"
    const todoId = "todo-public-completion-delivery"
    const latestAttemptId = params?.latestAttemptId ?? "pcia-latest"

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
    yield* db.insert(schema.toDo).values({
      id: todoId,
      processExecutionId,
      flowId: flow.id,
    })

    if (params?.oldAttemptId !== undefined) {
      yield* db.insert(schema.publicCompletionInvitationAttempt).values({
        id: params.oldAttemptId,
        toDoId: todoId,
        email: "old@example.com",
        providerMessageId: "email-old",
        createdAt: DateTime.unsafeMake("2026-06-01T09:00:00.000Z"),
      })
    }

    yield* db.insert(schema.publicCompletionInvitationAttempt).values({
      id: latestAttemptId,
      toDoId: todoId,
      email: "external@example.com",
      providerMessageId: "email-latest",
      createdAt: DateTime.unsafeMake("2026-06-01T10:00:00.000Z"),
    })

    return { latestAttemptId, processExecutionId, todoId }
  })

const getNotificationJobs = (
  enqueuedJobs: readonly EnqueuedJob[],
): NotificationDeliveryPayload[] =>
  enqueuedJobs
    .filter((job) => job.queue === NOTIFICATION_DELIVERY_QUEUE)
    .map((job) => job.payload as NotificationDeliveryPayload)

const expectNotificationIdempotencyKeys = (
  enqueuedJobs: readonly EnqueuedJob[],
) => {
  for (const job of enqueuedJobs.filter(
    ({ queue }) => queue === NOTIFICATION_DELIVERY_QUEUE,
  )) {
    expect((job.payload as NotificationDeliveryPayload).idempotencyKey).toBe(
      job.logicalJobId,
    )
  }
}

describe("Public Completion delivery callbacks", () => {
  it("records delivered callbacks without completing the public completion", async () => {
    const { org } = createPublicCompletionOrg()
    const { enqueuedJobs, layers } = createTestLayers(org)

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* storeOrganisation(org)
        const { latestAttemptId, todoId } =
          yield* insertWaitingPublicCompletion()

        const result = yield* applyPublicCompletionDeliveryCallback({
          status: "delivered",
          deliveryId: "msg-delivered",
          todoId,
          invitationAttemptId: latestAttemptId,
          providerMessageId: "email-latest",
        })

        expect(result._tag).toBe("Delivered")
        const attempts = yield* dbAttempts()
        expect(attempts[0]?.deliveryStatus).toBe("delivered")
        expect(attempts[0]?.deliveryEventId).toBe("msg-delivered")

        const todo = (yield* dbTodos())[0]
        expect(todo?._deleted).toBe(false)
        expect(todo?.failureReason).toBeNull()
        expect(todo?.completedByUserId).toBeNull()
      }).pipe(Effect.provide(layers)) as Effect.Effect<void>,
    )

    expect(enqueuedJobs).toEqual([])
  })

  it("ignores stale callbacks that do not match the latest attempt", async () => {
    const { org } = createPublicCompletionOrg()
    const { enqueuedJobs, layers } = createTestLayers(org)

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* storeOrganisation(org)
        const { todoId } = yield* insertWaitingPublicCompletion({
          oldAttemptId: "pcia-old",
          latestAttemptId: "pcia-new",
        })

        const result = yield* applyPublicCompletionDeliveryCallback({
          status: "failed",
          deliveryId: "msg-stale",
          todoId,
          invitationAttemptId: "pcia-old",
          providerMessageId: "email-old",
          failureKind: "recipient_address",
          failureReason: "Resend reported email.failed",
          failureDetails: { failureReasonDetail: "recipient_not_found" },
        })

        expect(result._tag).toBe("Ignored")
        const attempts = yield* dbAttempts()
        const oldAttempt = attempts.find((attempt) => attempt.id === "pcia-old")
        expect(oldAttempt?.deliveryStatus).toBeNull()
        const todo = (yield* dbTodos())[0]
        expect(todo?.failureReason).toBeNull()
      }).pipe(Effect.provide(layers)) as Effect.Effect<void>,
    )

    expect(enqueuedJobs).toEqual([])
  })

  it("ignores callbacks for already completed todos", async () => {
    const { employee, org } = createPublicCompletionOrg()
    const { enqueuedJobs, layers } = createTestLayers(org)

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* storeOrganisation(org)
        const { latestAttemptId, todoId } =
          yield* insertWaitingPublicCompletion()
        const employeeRoleId = yield* roleIdByPath(
          normalizePath(employee.node.path),
        )
        const db = yield* TypedSqliteDrizzle
        yield* db
          .update(schema.toDo)
          .set({ completedByRoleId: employeeRoleId })
          .where(eq(schema.toDo.id, todoId))

        const result = yield* applyPublicCompletionDeliveryCallback({
          status: "failed",
          deliveryId: "msg-completed",
          todoId,
          invitationAttemptId: latestAttemptId,
          providerMessageId: "email-latest",
          failureKind: "recipient_address",
          failureReason: "Resend reported email.failed",
        })

        expect(result._tag).toBe("Ignored")
        const attempt = (yield* dbAttempts())[0]
        expect(attempt?.deliveryStatus).toBeNull()
        const todo = (yield* dbTodos())[0]
        expect(todo?.failureReason).toBeNull()
      }).pipe(Effect.provide(layers)) as Effect.Effect<void>,
    )

    expect(enqueuedJobs).toEqual([])
  })

  it("fails provider transport failures even when correction is configured", async () => {
    const { org } = createPublicCompletionOrg({ correction: true })
    const { layers } = createTestLayers(org)

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* storeOrganisation(org)
        const { latestAttemptId, todoId } =
          yield* insertWaitingPublicCompletion()

        const result = yield* applyPublicCompletionDeliveryCallback({
          status: "failed",
          deliveryId: "msg-provider-failed",
          todoId,
          invitationAttemptId: latestAttemptId,
          providerMessageId: "email-latest",
          failureKind: "provider_transport",
          failureReason: "Resend reported email.failed",
          failureDetails: { failureReasonDetail: "provider_timeout" },
        })

        expect(result._tag).toBe("Failed")
        const attempt = (yield* dbAttempts())[0]
        expect(attempt?.deliveryStatus).toBe("failed")
        expect(attempt?.deliveryFailureKind).toBe("provider_transport")
        expect(attempt?.deliveryFailureReason).toContain("provider_timeout")
        const todo = (yield* dbTodos())[0]
        expect(todo?.failureReason).toContain("provider_timeout")
        expect(todo?.correctionRequiredAt).toBeNull()
      }).pipe(Effect.provide(layers)) as Effect.Effect<void>,
    )
  })

  it("enters correction required for configured recipient-address failures and notifies responsible users", async () => {
    const { employee, org } = createPublicCompletionOrg({ correction: true })
    const { enqueuedJobs, layers } = createTestLayers(org)

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* storeOrganisation(org)
        const employeeRoleId = yield* roleIdByPath(
          normalizePath(employee.node.path),
        )
        yield* insertProviderUser({
          userId: "usr-correction-responsible",
          providerUserId: "pu-correction-responsible",
          roleIds: [employeeRoleId],
          email: "responsible@example.com",
          name: "Responsible User",
          executionFailureEmailEnabled: false,
        })
        const { latestAttemptId, todoId } =
          yield* insertWaitingPublicCompletion()

        const result = yield* applyPublicCompletionDeliveryCallback({
          status: "failed",
          deliveryId: "msg-correction-required",
          todoId,
          invitationAttemptId: latestAttemptId,
          providerMessageId: "email-latest",
          failureKind: "recipient_address",
          failureReason: "Resend reported email.failed",
          failureDetails: { failureReasonDetail: "recipient_not_found" },
        })
        const lateDelivered = yield* applyPublicCompletionDeliveryCallback({
          status: "delivered",
          deliveryId: "msg-delivered-after-correction",
          todoId,
          invitationAttemptId: latestAttemptId,
          providerMessageId: "email-latest",
        })

        expect(result._tag).toBe("CorrectionRequired")
        expect(lateDelivered._tag).toBe("Ignored")
        const attempt = (yield* dbAttempts())[0]
        expect(attempt?.deliveryStatus).toBe("failed")
        expect(attempt?.deliveryEventId).toBe("msg-correction-required")
        expect(attempt?.deliveryFailureKind).toBe("recipient_address")
        const todo = (yield* dbTodos())[0]
        expect(todo?._deleted).toBe(false)
        expect(todo?.failureReason).toBeNull()
        expect(todo?.correctionRequiredAt).not.toBeNull()
        expect(todo?.correctionFailureReason).toContain("recipient_not_found")
        expect(todo?.correctionInvitationAttemptId).toBe(latestAttemptId)
      }).pipe(Effect.provide(layers)) as Effect.Effect<void>,
    )

    expect(enqueuedJobs.map((job) => job.queue)).toContain(TODO_EVENT_QUEUE)
    expect(enqueuedJobs.map((job) => job.queue)).toContain(PROCESS_EVENT_QUEUE)
    expect(enqueuedJobs.map((job) => job.queue)).toContain(
      EXECUTION_EVENT_QUEUE,
    )
    const notificationJobs = getNotificationJobs(enqueuedJobs)
    expect(notificationJobs).toHaveLength(1)
    const [notificationJob] = notificationJobs
    if (!notificationJob || !("correctionRequired" in notificationJob)) {
      throw new Error("Expected correction-required notification")
    }
    expect(notificationJob.recipient.email).toBe("responsible@example.com")
    expect(notificationJob.correctionRequired).toMatchObject({
      todoId: "todo-public-completion-delivery",
      processName: "Public Completion Delivery",
      stepName: "External Review",
    })
  })

  it("enters correction required when no responsible recipient can be notified", async () => {
    const { org } = createPublicCompletionOrg({ correction: true })
    const { enqueuedJobs, layers } = createTestLayers(org)

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* storeOrganisation(org)
        const { latestAttemptId, todoId } =
          yield* insertWaitingPublicCompletion()

        const result = yield* applyPublicCompletionDeliveryCallback({
          status: "failed",
          deliveryId: "msg-correction-no-recipient",
          todoId,
          invitationAttemptId: latestAttemptId,
          providerMessageId: "email-latest",
          failureKind: "recipient_address",
          failureReason: "Resend reported email.failed",
          failureDetails: { failureReasonDetail: "recipient_not_found" },
        })

        expect(result._tag).toBe("CorrectionRequired")
        const todo = (yield* dbTodos())[0]
        expect(todo?.failureReason).toBeNull()
        expect(todo?.correctionRequiredAt).not.toBeNull()
      }).pipe(Effect.provide(layers)) as Effect.Effect<void>,
    )

    expect(enqueuedJobs.map((job) => job.queue)).toContain(TODO_EVENT_QUEUE)
    expect(enqueuedJobs.map((job) => job.queue)).toContain(PROCESS_EVENT_QUEUE)
    expect(enqueuedJobs.map((job) => job.queue)).toContain(
      EXECUTION_EVENT_QUEUE,
    )
    expect(getNotificationJobs(enqueuedJobs)).toEqual([])
  })

  it("fails stale-path recipient-address failures instead of entering correction", async () => {
    const { org } = createPublicCompletionOrg({ correction: true })
    const { layers } = createTestLayers(org)

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* storeOrganisation(org)
        const { latestAttemptId, todoId } =
          yield* insertWaitingPublicCompletion()
        const db = yield* TypedSqliteDrizzle
        yield* db
          .update(schema.step)
          .set({ path: "/public-completion-delivery/stale-step" })
          .where(eq(schema.step.path, "/public-completion-delivery/review"))

        const result = yield* applyPublicCompletionDeliveryCallback({
          status: "failed",
          deliveryId: "msg-correction-stale-step",
          todoId,
          invitationAttemptId: latestAttemptId,
          providerMessageId: "email-latest",
          failureKind: "recipient_address",
          failureReason: "Resend reported email.failed",
          failureDetails: { failureReasonDetail: "recipient_not_found" },
        })

        expect(result._tag).toBe("Failed")
        const todo = (yield* dbTodos())[0]
        expect(todo?.correctionRequiredAt).toBeNull()
        expect(todo?.failureReason).toContain("recipient_not_found")
      }).pipe(Effect.provide(layers)) as Effect.Effect<void>,
    )
  })

  it("rolls back failure persistence when follow-up enqueue fails", async () => {
    const { org } = createPublicCompletionOrg()
    const { enqueuedJobs, layers } = createTestLayers(org, {
      failFirstEnqueue: true,
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* storeOrganisation(org)
        const { latestAttemptId, todoId } =
          yield* insertWaitingPublicCompletion()
        const callback = {
          status: "failed" as const,
          deliveryId: "msg-failed-enqueue-retry",
          todoId,
          invitationAttemptId: latestAttemptId,
          providerMessageId: "email-latest",
          failureKind: "recipient_address" as const,
          failureReason: "Resend reported email.failed",
          failureDetails: { failureReasonDetail: "recipient_not_found" },
        }

        const firstAttempt = yield* applyPublicCompletionDeliveryCallback(
          callback,
        ).pipe(
          Effect.match({
            onFailure: () => "enqueue-failed" as const,
            onSuccess: (result) => result._tag,
          }),
        )

        expect(firstAttempt).toBe("enqueue-failed")
        let attempt = (yield* dbAttempts())[0]
        expect(attempt?.deliveryStatus).toBeNull()
        let todo = (yield* dbTodos())[0]
        expect(todo?.failureReason).toBeNull()

        const retry = yield* applyPublicCompletionDeliveryCallback(callback)

        expect(retry._tag).toBe("Failed")
        attempt = (yield* dbAttempts())[0]
        expect(attempt?.deliveryStatus).toBe("failed")
        todo = (yield* dbTodos())[0]
        expect(todo?.failureReason).toContain("recipient_not_found")
      }).pipe(Effect.provide(layers)) as Effect.Effect<void>,
    )

    expect(enqueuedJobs.map((job) => job.queue)).toContain(TODO_EVENT_QUEUE)
    expect(enqueuedJobs.map((job) => job.queue)).toContain(PROCESS_EVENT_QUEUE)
    expect(enqueuedJobs.map((job) => job.queue)).toContain(
      EXECUTION_EVENT_QUEUE,
    )
  })

  it("sends no external jobs when persisting dispatch intent rolls back", async () => {
    const { org } = createPublicCompletionOrg()
    const { enqueuedJobs, layers } = createTestLayers(org, {
      queueInTransaction: false,
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* storeOrganisation(org)
        const { latestAttemptId, todoId } =
          yield* insertWaitingPublicCompletion()
        const sqlClient = yield* SqlClient.SqlClient
        yield* sqlClient.unsafe(`
          CREATE TRIGGER fail_public_completion_dispatch
          BEFORE INSERT ON pf_job_queue
          BEGIN
            SELECT RAISE(ABORT, 'forced dispatch persistence failure');
          END
        `)

        const result = yield* applyPublicCompletionDeliveryCallback({
          status: "failed",
          deliveryId: "msg-dispatch-rollback",
          todoId,
          invitationAttemptId: latestAttemptId,
          providerMessageId: "email-latest",
          failureKind: "provider_transport",
          failureReason: "Resend reported email.failed",
        }).pipe(
          Effect.match({
            onFailure: () => "rolled-back" as const,
            onSuccess: (callbackResult) => callbackResult._tag,
          }),
        )

        expect(result).toBe("rolled-back")
        expect((yield* dbAttempts())[0]?.deliveryStatus).toBeNull()
        expect((yield* dbTodos())[0]?.failureReason).toBeNull()
      }).pipe(Effect.provide(layers)) as Effect.Effect<void>,
    )

    expect(enqueuedJobs).toEqual([])
  })

  for (const failAt of [1, 2, 3, 4]) {
    it(`resumes correction dispatch after external enqueue ${failAt} fails`, async () => {
      const { employee, org } = createPublicCompletionOrg({ correction: true })
      const { enqueuedJobs, layers } = createTestLayers(org, {
        failEnqueueAttempts: [failAt],
        queueInTransaction: false,
      })

      await Effect.runPromise(
        Effect.gen(function* () {
          yield* storeOrganisation(org)
          const employeeRoleId = yield* roleIdByPath(
            normalizePath(employee.node.path),
          )
          yield* insertProviderUser({
            userId: "usr-correction-retry",
            providerUserId: "pu-correction-retry",
            roleIds: [employeeRoleId],
            email: "correction-retry@example.com",
            name: "Correction Retry",
            executionFailureEmailEnabled: false,
          })
          const { latestAttemptId, todoId } =
            yield* insertWaitingPublicCompletion()
          const callback = {
            status: "failed" as const,
            deliveryId: `msg-correction-retry-${failAt}`,
            todoId,
            invitationAttemptId: latestAttemptId,
            providerMessageId: "email-latest",
            failureKind: "recipient_address" as const,
            failureReason: "Resend reported email.failed",
          }

          const first = yield* applyPublicCompletionDeliveryCallback(
            callback,
          ).pipe(Effect.either)
          expect(first._tag).toBe("Left")

          const retry = yield* applyPublicCompletionDeliveryCallback(callback)
          expect(retry._tag).toBe("CorrectionRequired")
        }).pipe(Effect.provide(layers)) as Effect.Effect<void>,
      )

      expect(enqueuedJobs).toHaveLength(4)
      expect(new Set(enqueuedJobs.map((job) => job.logicalJobId)).size).toBe(4)
      expectNotificationIdempotencyKeys(enqueuedJobs)
    })
  }

  for (const failAt of [1, 2, 3, 4]) {
    it(`resumes terminal-failure dispatch after external enqueue ${failAt} fails`, async () => {
      const { employee, org } = createPublicCompletionOrg()
      const { enqueuedJobs, layers } = createTestLayers(org, {
        failEnqueueAttempts: [failAt],
        queueInTransaction: false,
      })

      await Effect.runPromise(
        Effect.gen(function* () {
          yield* storeOrganisation(org)
          const employeeRoleId = yield* roleIdByPath(
            normalizePath(employee.node.path),
          )
          yield* insertProviderUser({
            userId: "usr-terminal-retry",
            providerUserId: "pu-terminal-retry",
            roleIds: [employeeRoleId],
            email: "terminal-retry@example.com",
            name: "Terminal Retry",
            executionFailureEmailEnabled: true,
          })
          const { latestAttemptId, todoId } =
            yield* insertWaitingPublicCompletion()
          const callback = {
            status: "failed" as const,
            deliveryId: `msg-terminal-retry-${failAt}`,
            todoId,
            invitationAttemptId: latestAttemptId,
            providerMessageId: "email-latest",
            failureKind: "provider_transport" as const,
            failureReason: "Resend reported email.failed",
          }

          const first = yield* applyPublicCompletionDeliveryCallback(
            callback,
          ).pipe(Effect.either)
          expect(first._tag).toBe("Left")

          const retry = yield* applyPublicCompletionDeliveryCallback(callback)
          expect(retry._tag).toBe("Failed")
        }).pipe(Effect.provide(layers)) as Effect.Effect<void>,
      )

      expect(enqueuedJobs).toHaveLength(4)
      expect(new Set(enqueuedJobs.map((job) => job.logicalJobId)).size).toBe(4)
      expectNotificationIdempotencyKeys(enqueuedJobs)
    })
  }

  it("ignores delivered callbacks after a terminal failure", async () => {
    const { org } = createPublicCompletionOrg()
    const { layers } = createTestLayers(org)

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* storeOrganisation(org)
        const { latestAttemptId, todoId } =
          yield* insertWaitingPublicCompletion()

        const failed = yield* applyPublicCompletionDeliveryCallback({
          status: "failed",
          deliveryId: "msg-failed-first",
          todoId,
          invitationAttemptId: latestAttemptId,
          providerMessageId: "email-latest",
          failureKind: "recipient_address",
          failureReason: "Resend reported email.failed",
          failureDetails: { failureReasonDetail: "recipient_not_found" },
        })
        const delivered = yield* applyPublicCompletionDeliveryCallback({
          status: "delivered",
          deliveryId: "msg-delivered-late",
          todoId,
          invitationAttemptId: latestAttemptId,
          providerMessageId: "email-latest",
        })

        expect(failed._tag).toBe("Failed")
        expect(delivered._tag).toBe("Ignored")
        const attempt = (yield* dbAttempts())[0]
        expect(attempt?.deliveryStatus).toBe("failed")
        expect(attempt?.deliveryEventId).toBe("msg-failed-first")
        const todo = (yield* dbTodos())[0]
        expect(todo?.failureReason).toContain("recipient_not_found")
      }).pipe(Effect.provide(layers)) as Effect.Effect<void>,
    )
  })

  it("fails public completions when a terminal failure arrives after delivery", async () => {
    const { org } = createPublicCompletionOrg()
    const { layers } = createTestLayers(org)

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* storeOrganisation(org)
        const { latestAttemptId, todoId } =
          yield* insertWaitingPublicCompletion()

        const delivered = yield* applyPublicCompletionDeliveryCallback({
          status: "delivered",
          deliveryId: "msg-delivered-first",
          todoId,
          invitationAttemptId: latestAttemptId,
          providerMessageId: "email-latest",
        })
        const failed = yield* applyPublicCompletionDeliveryCallback({
          status: "failed",
          deliveryId: "msg-failed-late",
          todoId,
          invitationAttemptId: latestAttemptId,
          providerMessageId: "email-latest",
          failureKind: "recipient_address",
          failureReason: "Resend reported email.bounced",
          failureDetails: { bounceType: "hard" },
        })

        expect(delivered._tag).toBe("Delivered")
        expect(failed._tag).toBe("Failed")
        const attempt = (yield* dbAttempts())[0]
        expect(attempt?.deliveryStatus).toBe("failed")
        expect(attempt?.deliveryEventId).toBe("msg-failed-late")
        expect(attempt?.deliveryFailureKind).toBe("recipient_address")
        const todo = (yield* dbTodos())[0]
        expect(todo?.failureReason).toContain("bounceType=hard")
      }).pipe(Effect.provide(layers)) as Effect.Effect<void>,
    )
  })

  it("fails non-correctable terminal failures and notifies deduped recipients", async () => {
    const { employee, org, oversight } = createPublicCompletionOrg()
    const { enqueuedJobs, layers } = createTestLayers(org)
    const previousProject = process.env["PF_PROJECT"]
    const previousEnv = process.env["PF_ENV"]
    process.env["PF_PROJECT"] = "acme"
    process.env["PF_ENV"] = "prod"

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* storeOrganisation(org)
          const employeeRoleId = yield* roleIdByPath(
            normalizePath(employee.node.path),
          )
          const oversightRoleId = yield* roleIdByPath(
            normalizePath(oversight.node.path),
          )
          yield* insertProviderUser({
            userId: "usr-responsible",
            providerUserId: "pu-responsible",
            roleIds: [employeeRoleId],
            email: "responsible@example.com",
            name: "Responsible User",
            executionFailureEmailEnabled: true,
          })
          yield* insertProviderUser({
            userId: "usr-both",
            providerUserId: "pu-both",
            roleIds: [employeeRoleId, oversightRoleId],
            email: "both@example.com",
            name: "Both Roles",
            executionFailureEmailEnabled: true,
          })
          yield* insertProviderUser({
            userId: "usr-oversight",
            providerUserId: "pu-oversight",
            roleIds: [oversightRoleId],
            email: "oversight@example.com",
            name: "Oversight User",
            executionFailureEmailEnabled: true,
          })
          yield* insertProviderUser({
            userId: "usr-opted-out",
            providerUserId: "pu-opted-out",
            roleIds: [employeeRoleId],
            email: "opted-out@example.com",
            name: "Opted Out",
            executionFailureEmailEnabled: false,
          })
          const { latestAttemptId, todoId } =
            yield* insertWaitingPublicCompletion()

          const result = yield* applyPublicCompletionDeliveryCallback({
            status: "failed",
            deliveryId: "msg-failed",
            todoId,
            invitationAttemptId: latestAttemptId,
            providerMessageId: "email-latest",
            failureKind: "recipient_address",
            failureReason: "Resend reported email.failed",
            failureDetails: { failureReasonDetail: "recipient_not_found" },
          })

          expect(result._tag).toBe("Failed")
          const attempt = (yield* dbAttempts())[0]
          expect(attempt?.deliveryStatus).toBe("failed")
          expect(attempt?.deliveryFailureKind).toBe("recipient_address")
          expect(attempt?.deliveryFailureReason).toContain(
            "recipient_not_found",
          )
          const todo = (yield* dbTodos())[0]
          expect(todo?.failureReason).toContain("recipient_not_found")
        }).pipe(Effect.provide(layers)) as Effect.Effect<void>,
      )
    } finally {
      if (previousProject === undefined) delete process.env["PF_PROJECT"]
      else process.env["PF_PROJECT"] = previousProject
      if (previousEnv === undefined) delete process.env["PF_ENV"]
      else process.env["PF_ENV"] = previousEnv
    }

    expect(enqueuedJobs.map((job) => job.queue)).toContain(TODO_EVENT_QUEUE)
    expect(enqueuedJobs.map((job) => job.queue)).toContain(PROCESS_EVENT_QUEUE)
    expect(enqueuedJobs.map((job) => job.queue)).toContain(
      EXECUTION_EVENT_QUEUE,
    )
    const notificationJobs = getNotificationJobs(enqueuedJobs)
    expect(notificationJobs).toHaveLength(3)
    expect(notificationJobs.map((job) => job.recipient.email).sort()).toEqual([
      "both@example.com",
      "oversight@example.com",
      "responsible@example.com",
    ])
    for (const job of notificationJobs) {
      if (!("executionFailure" in job)) {
        throw new Error("Expected execution failure notification")
      }
      expect(job.executionFailure).toMatchObject({
        executionId: "pex-public-completion-delivery",
        processName: "Public Completion Delivery",
        project: "acme",
        environment: "prod",
      })
      expect(job.executionFailure.failureReason).toContain(
        "recipient_not_found",
      )
    }
  })
})

const dbAttempts = () =>
  Effect.gen(function* () {
    const db = yield* TypedSqliteDrizzle
    return yield* db.select().from(schema.publicCompletionInvitationAttempt)
  })

const dbTodos = () =>
  Effect.gen(function* () {
    const db = yield* TypedSqliteDrizzle
    return yield* db.select().from(schema.toDo)
  })
