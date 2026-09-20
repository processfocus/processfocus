import { randomUUID } from "node:crypto"
import { FileSystem } from "@effect/platform"
import { EnqueueError, QueueService } from "@processfocus/runtime"
import { DateTime, Schema as ES, Effect, FiberRef, Layer } from "effect"
import type { AuthorizationService } from "@pf/auth-policy"
import { type UserContext, systemSchema } from "@pf/graphql-api"
import {
  type FlowExecutionOperations,
  type ProcessExecutionOperations,
  StepCompletionOperations,
  UserDetails,
  type UserDetailsValue,
} from "@pf/graphql-db-operations"
import {
  PUBLIC_TODO_TOKEN_AUDIENCE,
  encryptPublicTodoToken,
} from "@pf/graphql-schema"
import {
  EXECUTION_EVENT_QUEUE,
  type EmailMessage,
  EmailSender,
  NOTIFICATION_DELIVERY_QUEUE,
  NotificationDeliveryConfig,
  type NotificationDeliveryPayload,
  PROCESS_EVENT_QUEUE,
  TODO_EVENT_QUEUE,
  applyPublicCompletionDeliveryCallback,
  notificationDeliveryHandler,
} from "@pf/job-handler"
import {
  Form,
  NodeStep,
  OrgUnit,
  Organisation,
  OrganisationProvider,
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
import { afterAll, beforeAll, describe, expect, it } from "bun:test"

const uniqueSuffix = () => randomUUID().slice(0, 8)
const runPostgresDbSpecs =
  process.env["PF_RUNTIME_LOCAL_POSTGRES_DB_SPECS"] === "1"

const SECRET = "public-todo-db-test-secret"
const originalPublicTodoTokenSecret = process.env["PUBLIC_TODO_TOKEN_SECRET"]

type PublicTodoNotificationDeliveryPayload = Extract<
  NotificationDeliveryPayload,
  { publicTodo: unknown }
>

const isPublicTodoNotificationDeliveryPayload = (
  payload: unknown,
): payload is PublicTodoNotificationDeliveryPayload =>
  typeof payload === "object" &&
  payload !== null &&
  "publicTodo" in payload &&
  "recipient" in payload

beforeAll(() => {
  process.env["PUBLIC_TODO_TOKEN_SECRET"] = SECRET
})

afterAll(() => {
  if (originalPublicTodoTokenSecret === undefined) {
    delete process.env["PUBLIC_TODO_TOKEN_SECRET"]
  } else {
    process.env["PUBLIC_TODO_TOKEN_SECRET"] = originalPublicTodoTokenSecret
  }
})

const makeContext = (): UserContext => ({
  _requestTime: DateTime.unsafeMake("2026-04-06T10:00:00.000Z"),
  _userDetails: { by: "frontend", id: null } as UserContext["_userDetails"],
  jwt: undefined,
  userId: "frontend",
})

const makePublicTodoAuthorizationLayer = () =>
  makeAuthorizationLayer({
    canCompleteStep: () => Effect.succeed(true),
    canCompleteTodo: () => Effect.succeed(true),
    canCorrectPublicCompletionTodo: () => Effect.succeed(true),
    canCompletePublicTodo: () => Effect.succeed(true),
  })

const makePublicTodoOrganisation = (
  suffix: string,
  stringThankYou = false,
  correction = false,
) => {
  const org = new Organisation({ name: `Public Todo Org ${suffix}` })
  const operations = new OrgUnit(org, `Public Todo Ops ${suffix}`, {
    name: `Public Todo Ops ${suffix}`,
    type: "department",
  })
  const employee = new Role(operations, "employee", { name: "Employee" })
  const process = new Process(operations, `public-todo-${suffix}`, {
    name: `Public Todo ${suffix}`,
    purpose: "Test public todo completion",
  })
  const start = new NodeStep(process, "Start", {
    input: () => Effect.succeed({}),
    output: {},
    execute: () => Effect.succeed({}),
  })
  const startFlow = process.start(start)
  const complete = new Form(startFlow, "Complete", {
    role: employee,
    form: () => ({ comment: ES.String }),
    publicCompletion: {
      recipient: (state: Record<string, unknown>) => ({
        email:
          typeof state["parentEmail"] === "string"
            ? state["parentEmail"]
            : "fresh@example.com",
        displayName: "Fresh Recipient",
      }),
      expiresAt: () => DateTime.unsafeMake("2026-04-07T10:00:00.000Z"),
      formTitle: "Complete your public task",
      formDescription: "Fill in the details and submit this form.",
      thankYou: stringThankYou
        ? "Thanks. Your public to-do was submitted."
        : () => Effect.succeed("Thanks. Your public to-do was submitted."),
      ...(correction
        ? {
            correction: {
              enabled: true as const,
              applyEmail: (_state, correctedEmail) => ({
                parentEmail: correctedEmail,
              }),
            },
          }
        : {}),
    },
  })
  startFlow.next(complete).end()

  return {
    form: complete,
    org,
    orgUnitPath: normalizePath(operations.node.path),
    rolePath: normalizePath(employee.node.path),
    processPath: normalizePath(process.node.path),
    startStepPath: normalizePath(start.node.path),
    todoStepPath: normalizePath(complete.node.path),
  }
}

const makeToken = (
  todoId: string,
  externalParticipantEmail?: string,
  publicCompletionInvitationAttemptId?: string,
) =>
  encryptPublicTodoToken(
    {
      v: 1,
      tid: todoId,
      ...(externalParticipantEmail ? { externalParticipantEmail } : {}),
      ...(publicCompletionInvitationAttemptId
        ? { publicCompletionInvitationAttemptId }
        : {}),
      iat: 1_775_472_000,
      exp: Math.floor(Date.now() / 1000) + 3600,
      aud: PUBLIC_TODO_TOKEN_AUDIENCE,
    },
    SECRET,
  )

const makePublicTodoLayer = <R>(
  db: GraphqlDbCase<R>,
  enqueuedJobs: EnqueuedJob[],
  organisation: Organisation,
  queueInTransaction = true,
) =>
  Layer.mergeAll(
    db.layer,
    makeQueueLayer(enqueuedJobs, queueInTransaction),
    makePublicTodoAuthorizationLayer(),
    Layer.succeed(FileSystem.FileSystem, {
      readFileString: () => Effect.succeed("type Query { _: Boolean }"),
    } as unknown as FileSystem.FileSystem),
    Layer.succeed(OrganisationProvider, {
      organisation,
      orgPath: "/tmp/org",
      schemaPath: "/tmp/org.graphql",
    }),
    Layer.succeed(
      UserDetails,
      FiberRef.unsafeMake<UserDetailsValue>({ by: "frontend", id: null }),
    ),
  )

type PublicTodoRequirements<R> =
  | R
  | AuthorizationService
  | FileSystem.FileSystem
  | FlowExecutionOperations
  | OrganisationProvider
  | ProcessExecutionOperations
  | QueueService
  | StepCompletionOperations
  | UserDetails

const runPublicTodoEffect = <R, A, E, RExtra = never>(
  db: GraphqlDbCase<R>,
  enqueuedJobs: EnqueuedJob[],
  organisation: Organisation,
  effect: Effect.Effect<A, E, PublicTodoRequirements<R> | RExtra>,
  queueInTransaction = true,
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        makePublicTodoLayer(
          db,
          enqueuedJobs,
          organisation,
          queueInTransaction,
        ) as Layer.Layer<PublicTodoRequirements<R>, unknown, never>,
      ),
    ) as Effect.Effect<A, E, never>,
  )

const completePublicTodoEffect = (
  token: string,
  input: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const schema = yield* systemSchema
    const resolver = schema.resolvers?.Mutation?.[
      "completePublicTodo"
    ] as unknown as (
      parent: unknown,
      args: { token: string; input?: Record<string, unknown> | null },
      context: UserContext,
    ) => Effect.Effect<Record<string, unknown>, unknown>

    return yield* resolver(undefined, { token, input }, makeContext())
  })

const queryPublicCompletionCorrectionEffect = (todoId: string) =>
  Effect.gen(function* () {
    const schema = yield* systemSchema
    const resolver = schema.resolvers?.Query?.[
      "publicCompletionCorrection"
    ] as unknown as (
      parent: unknown,
      args: { todoId: string },
      context: UserContext,
    ) => Effect.Effect<Record<string, unknown> | null, unknown>

    return yield* resolver(undefined, { todoId }, makeContext())
  })

const submitPublicCompletionCorrectionEffect = (
  todoId: string,
  correctedEmail: string,
) =>
  Effect.gen(function* () {
    const schema = yield* systemSchema
    const resolver = schema.resolvers?.Mutation?.[
      "submitPublicCompletionCorrection"
    ] as unknown as (
      parent: unknown,
      args: { todoId: string; correctedEmail: string },
      context: UserContext,
    ) => Effect.Effect<Record<string, unknown>, unknown>

    return yield* resolver(undefined, { todoId, correctedEmail }, makeContext())
  })

const deliverNotificationPayload = (
  payload: NotificationDeliveryPayload,
  jobId: string,
) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now
    yield* notificationDeliveryHandler.handle({
      jobId,
      receipt: "test-receipt",
      queue: NOTIFICATION_DELIVERY_QUEUE,
      payload,
      attempts: 1,
      maxAttempts: 5,
      availableAt: now,
      lockedUntil: now,
    })
  })

const makeCapturedEmailDeliveryLayer = (messages: EmailMessage[]) =>
  Layer.merge(
    Layer.succeed(NotificationDeliveryConfig, {
      getFrontendBaseUrl: () => "https://console.example.com",
      getSenderIdentity: () => ({ email: "notifications@example.com" }),
      getEnvironment: () => "test",
    }),
    Layer.succeed(EmailSender, {
      send: (message: EmailMessage) =>
        Effect.sync(() => {
          messages.push(message)
          return {
            providerMessageId: `message-${messages.length}`,
            providerSentTo: message.to,
          }
        }),
    }),
  )

const runSuite = <R>(db: GraphqlDbCase<R>) => {
  describe(`public todo completion (${db.name})`, () => {
    it("completes active public todos", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makePublicTodoOrganisation(
        `${db.name}-complete-${uniqueSuffix()}`,
      )
      const { activeTodo, result, todo } = await runPublicTodoEffect(
        db,
        enqueuedJobs,
        seed.org,
        Effect.gen(function* () {
          const activeTodo = yield* seedActiveTodo(db, {
            organisation: seed.org,
            orgUnitPath: seed.orgUnitPath,
            rolePath: seed.rolePath,
            processPath: seed.processPath,
            startStepPath: seed.startStepPath,
            todoStepPath: seed.todoStepPath,
          })
          const token = yield* makeToken(activeTodo.todoId)
          const result = yield* completePublicTodoEffect(token, {
            comment: "Done",
          })
          const todo = yield* db.getTodoById(activeTodo.todoId)
          return { activeTodo, result, todo }
        }),
      )

      expect(result).toMatchObject({
        todoId: activeTodo.todoId,
        status: "COMPLETED",
        completionMessage: "Thanks. Your public to-do was submitted.",
      })
      expect(todo?.deleted).toBe(true)
      expect(todo?.completedByExternalParticipantId).toBeNull()
      expect(enqueuedJobs).not.toEqual([])
    })

    it("recovers external enqueue when a completed public todo is submitted again", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makePublicTodoOrganisation(
        `${db.name}-external-recovery-${uniqueSuffix()}`,
      )
      const result = await runPublicTodoEffect(
        db,
        enqueuedJobs,
        seed.org,
        Effect.gen(function* () {
          const activeTodo = yield* seedActiveTodo(db, {
            organisation: seed.org,
            orgUnitPath: seed.orgUnitPath,
            rolePath: seed.rolePath,
            processPath: seed.processPath,
            startStepPath: seed.startStepPath,
            todoStepPath: seed.todoStepPath,
          })
          const token = yield* makeToken(activeTodo.todoId)
          const queueService = yield* QueueService
          const failingQueueService = {
            ...queueService,
            enqueue: (queue: string) =>
              Effect.fail(
                new EnqueueError({
                  queue,
                  message: "Simulated post-commit enqueue failure",
                }),
              ),
          } as unknown as QueueService["Type"]

          const firstError = yield* completePublicTodoEffect(token, {
            comment: "Done",
          }).pipe(
            Effect.provideService(QueueService, failingQueueService),
            Effect.flip,
          )
          const replayed = yield* completePublicTodoEffect(token, {
            comment: "Done",
          })
          return { firstError, replayed }
        }),
        false,
      )

      expect(result.firstError).toBeInstanceOf(EnqueueError)
      expect(result.replayed).toMatchObject({ status: "COMPLETED" })
      expect(enqueuedJobs).toHaveLength(4)
    })

    it("attributes public todo completions to the token external participant email", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makePublicTodoOrganisation(
        `${db.name}-participant-${uniqueSuffix()}`,
      )
      const { externalParticipantIds, todo } = await runPublicTodoEffect(
        db,
        enqueuedJobs,
        seed.org,
        Effect.gen(function* () {
          const activeTodo = yield* seedActiveTodo(db, {
            organisation: seed.org,
            orgUnitPath: seed.orgUnitPath,
            rolePath: seed.rolePath,
            processPath: seed.processPath,
            startStepPath: seed.startStepPath,
            todoStepPath: seed.todoStepPath,
          })
          const token = yield* makeToken(
            activeTodo.todoId,
            "parent@example.com",
          )
          yield* completePublicTodoEffect(token, { comment: "Done" })
          const todo = yield* db.getTodoById(activeTodo.todoId)
          const externalParticipantIds =
            yield* db.getExternalParticipantIdsByEmail("parent@example.com")
          return { externalParticipantIds, todo }
        }),
      )

      expect(externalParticipantIds).toHaveLength(1)
      expect(todo?.completedByExternalParticipantId).toBe(
        externalParticipantIds[0],
      )
    })

    it("uses string public completion messages", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makePublicTodoOrganisation(
        `${db.name}-string-message-${uniqueSuffix()}`,
        true,
      )
      const { activeTodo, result } = await runPublicTodoEffect(
        db,
        enqueuedJobs,
        seed.org,
        Effect.gen(function* () {
          const activeTodo = yield* seedActiveTodo(db, {
            organisation: seed.org,
            orgUnitPath: seed.orgUnitPath,
            rolePath: seed.rolePath,
            processPath: seed.processPath,
            startStepPath: seed.startStepPath,
            todoStepPath: seed.todoStepPath,
          })
          const token = yield* makeToken(activeTodo.todoId)
          const result = yield* completePublicTodoEffect(token, {
            comment: "Done",
          })
          return { activeTodo, result }
        }),
      )

      expect(result).toMatchObject({
        todoId: activeTodo.todoId,
        status: "COMPLETED",
        completionMessage: "Thanks. Your public to-do was submitted.",
      })
    })

    it("submits correction and reissues the public completion invitation", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makePublicTodoOrganisation(
        `${db.name}-correction-${uniqueSuffix()}`,
        false,
        true,
      )
      const result = await runPublicTodoEffect(
        db,
        enqueuedJobs,
        seed.org,
        Effect.gen(function* () {
          const activeTodo = yield* seedActiveTodo(db, {
            organisation: seed.org,
            orgUnitPath: seed.orgUnitPath,
            rolePath: seed.rolePath,
            processPath: seed.processPath,
            startStepPath: seed.startStepPath,
            todoStepPath: seed.todoStepPath,
            state: { parentEmail: "wrong@example.com" },
          })
          const stepCompletionOps = yield* StepCompletionOperations
          const attemptId =
            yield* stepCompletionOps.createPublicCompletionInvitationAttempt({
              todoId: activeTodo.todoId,
              recipientEmail: "wrong@example.com",
            })
          yield* stepCompletionOps.enterPublicCompletionCorrectionRequired({
            todoId: activeTodo.todoId,
            invitationAttemptId: attemptId,
            failureReason: "Recipient address rejected",
          })

          const correction = yield* queryPublicCompletionCorrectionEffect(
            activeTodo.todoId,
          )
          const submitted = yield* submitPublicCompletionCorrectionEffect(
            activeTodo.todoId,
            "Fixed@Example.com",
          )
          const todo = yield* db.getTodoById(activeTodo.todoId)
          const processState = yield* db.getProcessStateByExecutionId(
            activeTodo.executionId,
          )

          return { activeTodo, correction, processState, submitted, todo }
        }),
      )

      expect(result.correction).toMatchObject({
        todoId: result.activeTodo.todoId,
        correctedEmail: "wrong@example.com",
        failureReason: "Recipient address rejected",
      })
      expect(result.submitted).toMatchObject({
        todoId: result.activeTodo.todoId,
        correctedEmail: "fixed@example.com",
      })
      expect(result.todo?.deleted).toBe(false)
      expect(result.todo?.correctionRequiredAt).toBeNull()
      expect(result.processState?.state).toMatchObject({
        parentEmail: "fixed@example.com",
      })
      expect(enqueuedJobs).toHaveLength(4)
      expect(enqueuedJobs[0]).toMatchObject({
        queue: NOTIFICATION_DELIVERY_QUEUE,
        payload: {
          channel: "email",
          recipient: { email: "fixed@example.com" },
          publicTodo: { todoId: result.activeTodo.todoId },
        },
      })
      expect(enqueuedJobs[1]).toEqual({
        queue: TODO_EVENT_QUEUE,
        payload: { todoIds: [result.activeTodo.todoId] },
      })
      expect(enqueuedJobs[2]).toEqual({
        queue: PROCESS_EVENT_QUEUE,
        payload: { processId: result.activeTodo.processId },
      })
      expect(enqueuedJobs[3]).toEqual({
        queue: EXECUTION_EVENT_QUEUE,
        payload: { executionId: result.activeTodo.executionId },
      })
    })

    it("runs the full public completion correction lifecycle through notification delivery and provider-neutral callbacks", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const deliveredMessages: EmailMessage[] = []
      const emailDeliveryLayer =
        makeCapturedEmailDeliveryLayer(deliveredMessages)
      const seed = makePublicTodoOrganisation(
        `${db.name}-full-correction-${uniqueSuffix()}`,
        false,
        true,
      )

      const result = await runPublicTodoEffect(
        db,
        enqueuedJobs,
        seed.org,
        Effect.gen(function* () {
          const activeTodo = yield* seedActiveTodo(db, {
            organisation: seed.org,
            orgUnitPath: seed.orgUnitPath,
            rolePath: seed.rolePath,
            processPath: seed.processPath,
            startStepPath: seed.startStepPath,
            todoStepPath: seed.todoStepPath,
            state: { parentEmail: "wrong@example.com" },
          })
          const stepCompletionOps = yield* StepCompletionOperations
          const initialAttemptId =
            yield* stepCompletionOps.createPublicCompletionInvitationAttempt({
              todoId: activeTodo.todoId,
              recipientEmail: "wrong@example.com",
            })
          const oldToken = yield* makeToken(
            activeTodo.todoId,
            "wrong@example.com",
            initialAttemptId,
          )
          const initialPayload: NotificationDeliveryPayload = {
            channel: "email",
            recipient: {
              email: "wrong@example.com",
              displayName: "Wrong Recipient",
            },
            publicTodo: {
              todoId: activeTodo.todoId,
              processName: "Public Todo",
              stepName: "Complete",
              token: oldToken,
              expiresAt: "2026-04-07T10:00:00.000Z",
              publicCompletionInvitationAttemptId: initialAttemptId,
            },
          }

          yield* deliverNotificationPayload(
            initialPayload,
            "job-initial-public-completion",
          ).pipe(Effect.provide(emailDeliveryLayer))
          const initialMessage = deliveredMessages.find(
            (message) => message.to === "wrong@example.com",
          )
          if (initialMessage === undefined) {
            return yield* Effect.dieMessage(
              "Expected email sender to capture initial invitation",
            )
          }

          const failureCallbackResult =
            yield* applyPublicCompletionDeliveryCallback({
              status: "failed",
              deliveryId: "msg-recipient-failed",
              todoId: activeTodo.todoId,
              invitationAttemptId: initialAttemptId,
              providerMessageId: "message-1",
              failureKind: "recipient_address",
              failureReason: "Resend reported recipient_not_found",
            })
          const afterFailureTodo = yield* db.getTodoById(activeTodo.todoId)
          const afterFailureExecution = yield* db.getProcessExecutionStatus(
            activeTodo.executionId,
          )
          const afterFailureAttempts =
            yield* db.getPublicCompletionInvitationAttemptsByTodoId(
              activeTodo.todoId,
            )
          const correction = yield* queryPublicCompletionCorrectionEffect(
            activeTodo.todoId,
          )

          const submitted = yield* submitPublicCompletionCorrectionEffect(
            activeTodo.todoId,
            "Fixed@Example.com",
          )
          // The corrected recipient match makes email normalization explicit.
          const freshPayload = enqueuedJobs
            .map((job) => job.payload)
            .find(
              (payload): payload is PublicTodoNotificationDeliveryPayload =>
                isPublicTodoNotificationDeliveryPayload(payload) &&
                payload.recipient.email === "fixed@example.com" &&
                typeof payload.publicTodo.token === "string",
            )
          if (freshPayload === undefined) {
            return yield* Effect.dieMessage(
              "Expected corrected public completion invitation job",
            )
          }

          yield* deliverNotificationPayload(
            freshPayload,
            "job-corrected-public-completion",
          ).pipe(Effect.provide(emailDeliveryLayer))
          const freshAttemptId =
            freshPayload.publicTodo.publicCompletionInvitationAttemptId
          if (freshAttemptId === undefined) {
            return yield* Effect.dieMessage(
              "Expected corrected invitation attempt id",
            )
          }
          const correctedMessage = deliveredMessages.find(
            (message) => message.to === "fixed@example.com",
          )
          const afterCorrectionTodo = yield* db.getTodoById(activeTodo.todoId)
          const oldLinkResult = yield* completePublicTodoEffect(oldToken, {
            comment: "Stale",
          })
          const afterOldLink = yield* db.getTodoById(activeTodo.todoId)
          const newLinkResult = yield* completePublicTodoEffect(
            freshPayload.publicTodo.token,
            { comment: "Done" },
          )
          const afterNewLink = yield* db.getTodoById(activeTodo.todoId)
          const externalParticipantIds =
            yield* db.getExternalParticipantIdsByEmail("fixed@example.com")
          const attempts =
            yield* db.getPublicCompletionInvitationAttemptsByTodoId(
              activeTodo.todoId,
            )

          return {
            activeTodo,
            afterCorrectionTodo,
            afterFailureAttempts,
            afterFailureExecution,
            afterFailureTodo,
            afterNewLink,
            afterOldLink,
            attempts,
            correctedMessage,
            correction,
            failureCallbackResult,
            externalParticipantIds,
            freshPayload,
            initialAttemptId,
            initialMessage,
            newLinkResult,
            oldLinkResult,
            submitted,
          }
        }),
      )

      expect(result.initialMessage.to).toBe("wrong@example.com")
      expect(result.failureCallbackResult._tag).toBe("CorrectionRequired")
      const failedAttempt = result.afterFailureAttempts.find(
        (attempt) => attempt.id === result.initialAttemptId,
      )
      expect(failedAttempt).toMatchObject({
        deliveryStatus: "failed",
        deliveryEventId: "msg-recipient-failed",
        deliveryFailureKind: "recipient_address",
      })
      expect(failedAttempt?.deliveryFailureReason).toContain(
        "recipient_not_found",
      )
      expect(result.afterFailureTodo).toMatchObject({
        deleted: false,
        failureReason: null,
      })
      expect(result.afterFailureTodo?.correctionRequiredAt).not.toBeNull()
      expect(result.afterFailureExecution).toMatchObject({
        finishedAt: null,
        abandonedAt: null,
      })
      expect(result.correction).toMatchObject({
        todoId: result.activeTodo.todoId,
        correctedEmail: "wrong@example.com",
      })
      expect(result.submitted).toMatchObject({
        todoId: result.activeTodo.todoId,
        correctedEmail: "fixed@example.com",
      })
      expect(result.freshPayload).toMatchObject({
        recipient: { email: "fixed@example.com" },
        publicTodo: { todoId: result.activeTodo.todoId },
      })
      if (result.correctedMessage === undefined) {
        throw new Error("Expected email sender to capture corrected invitation")
      }
      expect(result.correctedMessage.to).toBe("fixed@example.com")
      expect(result.afterCorrectionTodo).toMatchObject({
        deleted: false,
        correctionRequiredAt: null,
        failureReason: null,
      })
      expect(result.oldLinkResult).toMatchObject({
        todoId: result.activeTodo.todoId,
        status: "UNAVAILABLE",
      })
      expect(result.afterOldLink?.deleted).toBe(false)
      expect(result.newLinkResult).toMatchObject({
        todoId: result.activeTodo.todoId,
        status: "COMPLETED",
      })
      if (result.afterNewLink === null) {
        throw new Error(
          "Expected todo to exist after completing corrected link",
        )
      }
      expect(result.externalParticipantIds).toHaveLength(1)
      const [externalParticipantId] = result.externalParticipantIds
      if (externalParticipantId === undefined) {
        throw new Error("Expected corrected participant id")
      }
      expect(result.afterNewLink.deleted).toBe(true)
      expect(result.afterNewLink.completedByExternalParticipantId).toBe(
        externalParticipantId,
      )
      expect(result.attempts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: result.initialAttemptId,
            email: "wrong@example.com",
            deliveryStatus: "failed",
          }),
          expect.objectContaining({
            email: "fixed@example.com",
            providerSentTo: "fixed@example.com",
          }),
        ]),
      )
    })

    it("rejects old recipient links after correction and accepts the new recipient link", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makePublicTodoOrganisation(
        `${db.name}-stale-recipient-${uniqueSuffix()}`,
        false,
        true,
      )
      const result = await runPublicTodoEffect(
        db,
        enqueuedJobs,
        seed.org,
        Effect.gen(function* () {
          const activeTodo = yield* seedActiveTodo(db, {
            organisation: seed.org,
            orgUnitPath: seed.orgUnitPath,
            rolePath: seed.rolePath,
            processPath: seed.processPath,
            startStepPath: seed.startStepPath,
            todoStepPath: seed.todoStepPath,
            state: { parentEmail: "wrong@example.com" },
          })
          const stepCompletionOps = yield* StepCompletionOperations
          const oldAttemptId =
            yield* stepCompletionOps.createPublicCompletionInvitationAttempt({
              todoId: activeTodo.todoId,
              recipientEmail: "wrong@example.com",
            })
          const oldToken = yield* makeToken(
            activeTodo.todoId,
            "wrong@example.com",
            oldAttemptId,
          )
          yield* stepCompletionOps.enterPublicCompletionCorrectionRequired({
            todoId: activeTodo.todoId,
            invitationAttemptId: oldAttemptId,
            failureReason: "Recipient address rejected",
          })

          yield* submitPublicCompletionCorrectionEffect(
            activeTodo.todoId,
            "fixed@example.com",
          )
          const freshPayload = enqueuedJobs[0]?.payload
          if (
            typeof freshPayload !== "object" ||
            freshPayload === null ||
            !("publicTodo" in freshPayload) ||
            typeof freshPayload.publicTodo !== "object" ||
            freshPayload.publicTodo === null ||
            !("token" in freshPayload.publicTodo) ||
            typeof freshPayload.publicTodo.token !== "string"
          ) {
            throw new Error("Expected fresh public todo token job")
          }

          const oldLinkResult = yield* completePublicTodoEffect(oldToken, {
            comment: "Stale",
          })
          const afterOldLink = yield* db.getTodoById(activeTodo.todoId)
          const newLinkResult = yield* completePublicTodoEffect(
            freshPayload.publicTodo.token,
            { comment: "Done" },
          )
          const afterNewLink = yield* db.getTodoById(activeTodo.todoId)
          const externalParticipantIds =
            yield* db.getExternalParticipantIdsByEmail("fixed@example.com")

          return {
            activeTodo,
            afterNewLink,
            afterOldLink,
            externalParticipantIds,
            newLinkResult,
            oldLinkResult,
          }
        }),
      )

      expect(result.oldLinkResult).toMatchObject({
        todoId: result.activeTodo.todoId,
        status: "UNAVAILABLE",
      })
      expect(result.afterOldLink?.deleted).toBe(false)
      expect(result.newLinkResult).toMatchObject({
        todoId: result.activeTodo.todoId,
        status: "COMPLETED",
      })
      expect(result.afterNewLink?.deleted).toBe(true)
      expect(result.afterNewLink?.completedByExternalParticipantId).toBe(
        result.externalParticipantIds[0],
      )
    })
  })
}

runSuite(sqliteDbCase)
if (runPostgresDbSpecs) {
  runSuite(postgresDbCase)
}
