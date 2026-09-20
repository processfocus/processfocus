import { DateTime, Effect, Layer, Schema } from "effect"
import { StepCompletionOperations } from "@pf/graphql-db-operations"
import {
  type EmailMessage,
  EmailSender,
  NOTIFICATION_DELIVERY_QUEUE,
  NotificationDeliveryConfig,
  NotificationDeliveryPayloadSchema,
  NotificationDeliverySendError,
  notificationDeliveryHandler,
} from "@pf/job-handler"
import { describe, expect, it } from "bun:test"

const makeReceiptOpsLayer = (
  recordPublicCompletionInvitationAttemptReceipt: StepCompletionOperations["Type"]["recordPublicCompletionInvitationAttemptReceipt"],
) => {
  const receiptOps = {
    createPublicCompletionInvitationAttempt: () =>
      Effect.die(
        "createPublicCompletionInvitationAttempt should not be called by notification delivery",
      ),
    recordPublicCompletionInvitationAttemptReceipt,
  } satisfies Pick<
    StepCompletionOperations["Type"],
    | "createPublicCompletionInvitationAttempt"
    | "recordPublicCompletionInvitationAttemptReceipt"
  >

  return Layer.succeed(
    StepCompletionOperations,
    receiptOps as StepCompletionOperations["Type"],
  )
}

describe("Notification Delivery Handler", () => {
  it("renders a task-assignment email and delegates it to the sender", async () => {
    const emails: EmailMessage[] = []
    const idempotencyKeys: (string | undefined)[] = []

    const TestLayer = Layer.mergeAll(
      Layer.succeed(NotificationDeliveryConfig, {
        getFrontendBaseUrl: () => "https://console.example.com",
        getEnvironment: () => undefined,
        getSenderIdentity: () => ({
          email: "notifications@example.com",
          name: "Process Focus",
        }),
      }),
      Layer.succeed(EmailSender, {
        send: (message, options) =>
          Effect.sync(() => {
            emails.push(message)
            idempotencyKeys.push(options?.idempotencyKey)
            return undefined
          }),
      }),
    )

    const program = Effect.gen(function* () {
      const now = yield* DateTime.now
      yield* notificationDeliveryHandler.handle({
        jobId: "job-notification-001",
        queue: NOTIFICATION_DELIVERY_QUEUE,
        payload: {
          channel: "email",
          idempotencyKey: "notification-delivery-001",
          recipient: {
            userId: "usr-123",
            email: "person@example.com",
            displayName: "Pat Person",
          },
          todo: {
            todoId: "todo-123",
            stepPath: "finance/purchase/finish",
            processName: "Purchase approval",
            stepName: "Finish purchase",
          },
        },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      })
    })

    await Effect.runPromise(
      program.pipe(Effect.provide(TestLayer)) as Effect.Effect<void>,
    )

    expect(emails).toHaveLength(1)
    expect(idempotencyKeys).toEqual(["notification-delivery-001"])
    expect(emails[0]).toEqual({
      to: "person@example.com",
      from: "Process Focus <notifications@example.com>",
      subject: "New task assigned: Purchase approval / Finish purchase",
      html: expect.stringContaining("Hello Pat Person,"),
    })
    expect(emails[0]?.html).toContain("Purchase approval")
    expect(emails[0]?.html).toContain("Finish purchase")
    expect(emails[0]?.html).toContain(
      "https://console.example.com/to-dos/complete/finance/purchase/finish?todoId=todo-123",
    )
    expect(emails[0]?.html).toContain("Open to-do")
  })

  it("renders a correction-required email with correction context", async () => {
    const emails: EmailMessage[] = []

    const TestLayer = Layer.mergeAll(
      Layer.succeed(NotificationDeliveryConfig, {
        getFrontendBaseUrl: () => "https://console.example.com",
        getEnvironment: () => undefined,
        getSenderIdentity: () => ({
          email: "notifications@example.com",
          name: "Process Focus",
        }),
      }),
      Layer.succeed(EmailSender, {
        send: (message) =>
          Effect.sync(() => {
            emails.push(message)
            return undefined
          }),
      }),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const now = yield* DateTime.now
        yield* notificationDeliveryHandler.handle({
          jobId: "job-notification-correction-001",
          queue: NOTIFICATION_DELIVERY_QUEUE,
          payload: {
            channel: "email",
            recipient: {
              userId: "usr-123",
              email: "person@example.com",
              displayName: "Pat Person",
            },
            correctionRequired: {
              todoId: "todo-123",
              processName: "Purchase approval",
              stepName: "External review",
              failureReason: "recipient_not_found",
            },
          },
          attempts: 1,
          maxAttempts: 5,
          availableAt: now,
          lockedUntil: now,
        })
      }).pipe(Effect.provide(TestLayer)) as Effect.Effect<void>,
    )

    expect(emails).toHaveLength(1)
    expect(emails[0]).toMatchObject({
      to: "person@example.com",
      from: "Process Focus <notifications@example.com>",
      subject: "Correction required: Purchase approval / External review",
    })
    expect(emails[0]?.html).toContain(
      "A Public Completion invitation could not be delivered",
    )
    expect(emails[0]?.html).toContain("recipient_not_found")
    expect(emails[0]?.html).toContain("Go to My To-Dos")
    expect(emails[0]?.html).not.toContain("/to-dos/complete/")
    expect(emails[0]?.html).toContain("https://console.example.com/to-dos")
  })

  it("renders an Access Review control email with operational identifiers only", async () => {
    const emails: EmailMessage[] = []

    const TestLayer = Layer.mergeAll(
      Layer.succeed(NotificationDeliveryConfig, {
        getFrontendBaseUrl: () => "https://console.example.com",
        getEnvironment: () => undefined,
        getSenderIdentity: () => ({
          email: "notifications@example.com",
          name: "Process Focus",
        }),
      }),
      Layer.succeed(EmailSender, {
        send: (message) =>
          Effect.sync(() => {
            emails.push(message)
            return undefined
          }),
      }),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const now = yield* DateTime.now
        yield* notificationDeliveryHandler.handle({
          jobId: "job-notification-access-review-001",
          queue: NOTIFICATION_DELIVERY_QUEUE,
          payload: {
            channel: "email",
            recipient: {
              userId: "usr-admin",
              email: "admin@example.com",
              displayName: "Admin User",
            },
            accessReviewControl: {
              failureCategory: "review-sla-overdue",
              project: "0000-1000-1000",
              environment: "prod",
              processPath: "/operations/weekly-access-review",
              investigationReference:
                "Open Access Review Todo todo-abc past two-business-day SLA",
              executionId: "pex-01TESTEXECUTIONID000000000001",
              todoId: "todo-abc",
              dueAt: "2026-08-04T05:00:00.000Z",
            },
          },
          attempts: 1,
          maxAttempts: 5,
          availableAt: now,
          lockedUntil: now,
        })
      }).pipe(Effect.provide(TestLayer)) as Effect.Effect<void>,
    )

    expect(emails).toHaveLength(1)
    expect(emails[0]?.subject).toContain("Access Review SLA overdue")
    expect(emails[0]?.html).toContain("todo-abc")
    expect(emails[0]?.html).toContain("pex-01TESTEXECUTIONID000000000001")
    expect(emails[0]?.html).toContain(
      "https://console.example.com/executions/pex-01TESTEXECUTIONID000000000001",
    )
    expect(emails[0]?.html).not.toContain("providerUserAccess")
    expect(emails[0]?.html).not.toContain("credential report")
  })

  it("re-raises sender failures so the queue can retry", async () => {
    const TestLayer = Layer.mergeAll(
      Layer.succeed(NotificationDeliveryConfig, {
        getFrontendBaseUrl: () => "https://console.example.com",
        getEnvironment: () => undefined,
        getSenderIdentity: () => ({
          email: "notifications@example.com",
        }),
      }),
      Layer.succeed(EmailSender, {
        send: () =>
          Effect.fail(
            new NotificationDeliverySendError({
              recipientEmail: "person@example.com",
              message: "Resend unavailable",
            }),
          ),
      }),
    )

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const now = yield* DateTime.now
          yield* notificationDeliveryHandler.handle({
            jobId: "job-notification-002",
            queue: NOTIFICATION_DELIVERY_QUEUE,
            payload: {
              channel: "email",
              recipient: {
                userId: "usr-123",
                email: "person@example.com",
              },
              todo: {
                todoId: "todo-123",
                stepPath: "finance/purchase/finish",
                processName: "Purchase approval",
                stepName: "Finish purchase",
              },
            },
            attempts: 1,
            maxAttempts: 5,
            availableAt: now,
            lockedUntil: now,
          })
        }).pipe(Effect.provide(TestLayer)) as Effect.Effect<
          void,
          NotificationDeliverySendError
        >,
      ),
    ).rejects.toThrow("Resend unavailable")
  })

  it("renders a public-completion email with public URL and expiry", async () => {
    const emails: EmailMessage[] = []

    const TestLayer = Layer.mergeAll(
      Layer.succeed(NotificationDeliveryConfig, {
        getFrontendBaseUrl: () => "https://console.example.com",
        getEnvironment: () => undefined,
        getSenderIdentity: () => ({
          email: "notifications@example.com",
          name: "Process Focus",
        }),
      }),
      Layer.succeed(EmailSender, {
        send: (message) =>
          Effect.sync(() => {
            emails.push(message)
            return undefined
          }),
      }),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const now = yield* DateTime.now
        const payload = yield* Schema.decodeUnknown(
          NotificationDeliveryPayloadSchema,
        )({
          channel: "email",
          recipient: {
            email: "external@example.com",
            displayName: "External Reviewer",
          },
          publicTodo: {
            todoId: "todo-123",
            processName: "Purchase approval",
            stepName: "External review",
            token: "public-token-123",
            expiresAt: "2026-05-01T10:00:00.000Z",
            subject: "Please complete external review",
            body: "Dear External Reviewer,\n\nPlease [complete this public form]({{publicUrl}}).",
            attachments: [
              {
                filename: "review.pdf",
                storePrefix: "/review-documents",
                fileId: "file-review-001",
              },
            ],
          },
        })
        yield* notificationDeliveryHandler.handle({
          jobId: "job-notification-public-001",
          queue: NOTIFICATION_DELIVERY_QUEUE,
          payload,
          attempts: 1,
          maxAttempts: 5,
          availableAt: now,
          lockedUntil: now,
        })
      }).pipe(Effect.provide(TestLayer)) as Effect.Effect<void>,
    )

    expect(emails).toHaveLength(1)
    expect(emails[0]).toEqual({
      to: "external@example.com",
      from: "Process Focus <notifications@example.com>",
      subject: "Please complete external review",
      html: expect.stringContaining("Dear External Reviewer,"),
      attachments: [
        {
          filename: "review.pdf",
          storePrefix: "/review-documents",
          fileId: "file-review-001",
        },
      ],
    })
    expect(emails[0]?.html).toContain(
      "https://console.example.com/public/form/public-token-123",
    )
    expect(emails[0]?.html).not.toContain("2026-05-01T10:00:00.000Z")
    expect(emails[0]?.html).toContain(
      '<a href="https://console.example.com/public/form/public-token-123">complete this public form</a>',
    )
    expect(emails[0]?.html).not.toContain("Open form")
    expect(emails[0]?.html).toContain(
      "If the link above does not work, use this URL:",
    )
  })

  it("delegates public-completion template emails to the sender", async () => {
    const emails: EmailMessage[] = []

    const TestLayer = Layer.mergeAll(
      Layer.succeed(NotificationDeliveryConfig, {
        getFrontendBaseUrl: () => "https://console.example.com",
        getEnvironment: () => undefined,
        getSenderIdentity: () => ({
          email: "notifications@example.com",
          name: "Process Focus",
        }),
      }),
      Layer.succeed(EmailSender, {
        send: (message) =>
          Effect.sync(() => {
            emails.push(message)
            return undefined
          }),
      }),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const now = yield* DateTime.now
        yield* notificationDeliveryHandler.handle({
          jobId: "job-notification-public-template-001",
          queue: NOTIFICATION_DELIVERY_QUEUE,
          payload: {
            channel: "email",
            recipient: {
              email: "external@example.com",
              displayName: "External Reviewer",
            },
            publicTodo: {
              todoId: "todo-123",
              processName: "Purchase approval",
              stepName: "External review",
              token: "public-token-123",
              expiresAt: "2026-05-01T10:00:00.000Z",
              subject: "Please complete external review",
              template: {
                id: "external-review-template",
                variables: {
                  NAME: "External Reviewer",
                },
              },
            },
          },
          attempts: 1,
          maxAttempts: 5,
          availableAt: now,
          lockedUntil: now,
        })
      }).pipe(Effect.provide(TestLayer)) as Effect.Effect<void>,
    )

    expect(emails).toHaveLength(1)
    expect(emails[0]).toEqual({
      to: "external@example.com",
      from: "Process Focus <notifications@example.com>",
      subject: "Please complete external review",
      template: {
        id: "external-review-template",
        variables: {
          NAME: "External Reviewer",
          PUBLIC_URL:
            "https://console.example.com/public/form/public-token-123",
        },
      },
    })
    expect(emails[0]?.html).toBeUndefined()
  })

  it("sends public-completion emails from the process sender when provided", async () => {
    const emails: EmailMessage[] = []

    const TestLayer = Layer.mergeAll(
      Layer.succeed(NotificationDeliveryConfig, {
        getFrontendBaseUrl: () => "https://console.example.com",
        getEnvironment: () => undefined,
        getSenderIdentity: () => ({
          email: "notifications@example.com",
          name: "Process Focus",
        }),
      }),
      Layer.succeed(EmailSender, {
        send: (message) =>
          Effect.sync(() => {
            emails.push(message)
            return undefined
          }),
      }),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const now = yield* DateTime.now
        yield* notificationDeliveryHandler.handle({
          jobId: "job-notification-public-from-001",
          queue: NOTIFICATION_DELIVERY_QUEUE,
          payload: {
            channel: "email",
            recipient: {
              email: "external@example.com",
              displayName: "External Reviewer",
            },
            publicTodo: {
              todoId: "todo-123",
              processName: "Purchase approval",
              stepName: "External review",
              token: "public-token-123",
              expiresAt: "2026-05-01T10:00:00.000Z",
              from: "Award Leader <award.leader@example.com>",
              subject: "Please complete external review",
              template: {
                id: "external-review-template",
                variables: {
                  NAME: "External Reviewer",
                },
              },
            },
          },
          attempts: 1,
          maxAttempts: 5,
          availableAt: now,
          lockedUntil: now,
        })
      }).pipe(Effect.provide(TestLayer)) as Effect.Effect<void>,
    )

    expect(emails).toHaveLength(1)
    expect(emails[0]?.from).toBe("Award Leader <award.leader@example.com>")
  })

  it("adds public-completion provider tags and records delivery receipts", async () => {
    const emails: EmailMessage[] = []
    const recordedReceipts: Array<{
      readonly attemptId: string
      readonly providerMessageId: string
      readonly providerSentTo: string
    }> = []

    const TestLayer = Layer.mergeAll(
      Layer.succeed(NotificationDeliveryConfig, {
        getFrontendBaseUrl: () => "https://console.example.com",
        getEnvironment: () => "dev",
        getSenderIdentity: () => ({
          email: "notifications@example.com",
          name: "Process Focus",
        }),
      }),
      Layer.succeed(EmailSender, {
        send: (message) =>
          Effect.sync(() => {
            emails.push(message)
            return {
              providerMessageId: "email-public-123",
              providerSentTo: "rerouted@example.com",
            }
          }),
      }),
      makeReceiptOpsLayer((attemptId, receipt) =>
        Effect.sync(() => {
          recordedReceipts.push({
            attemptId,
            providerMessageId: receipt.providerMessageId,
            providerSentTo: receipt.providerSentTo,
          })
          return true
        }),
      ),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const now = yield* DateTime.now
        yield* notificationDeliveryHandler.handle({
          jobId: "job-notification-public-receipt-001",
          queue: NOTIFICATION_DELIVERY_QUEUE,
          payload: {
            channel: "email",
            recipient: {
              email: "external@example.com",
              displayName: "External Reviewer",
            },
            publicTodo: {
              todoId: "todo-123",
              processName: "Purchase approval",
              stepName: "External review",
              token: "public-token-123",
              expiresAt: "2026-05-01T10:00:00.000Z",
              publicCompletionInvitationAttemptId: "pcia-123",
            },
          },
          attempts: 1,
          maxAttempts: 5,
          availableAt: now,
          lockedUntil: now,
        })
      }).pipe(Effect.provide(TestLayer)) as Effect.Effect<void>,
    )

    expect(emails).toHaveLength(1)
    expect(emails[0]?.tags).toEqual([
      { name: "pf_public_completion_todo_id", value: "todo-123" },
      { name: "pf_public_completion_environment", value: "dev" },
      {
        name: "pf_public_completion_invitation_attempt_id",
        value: "pcia-123",
      },
    ])
    expect(recordedReceipts).toEqual([
      {
        attemptId: "pcia-123",
        providerMessageId: "email-public-123",
        providerSentTo: "rerouted@example.com",
      },
    ])
  })

  it("does not record receipts for legacy public-completion jobs without attempt ids", async () => {
    const emails: EmailMessage[] = []

    const TestLayer = Layer.mergeAll(
      Layer.succeed(NotificationDeliveryConfig, {
        getFrontendBaseUrl: () => "https://console.example.com",
        getEnvironment: () => "dev",
        getSenderIdentity: () => ({
          email: "notifications@example.com",
          name: "Process Focus",
        }),
      }),
      Layer.succeed(EmailSender, {
        send: (message) =>
          Effect.sync(() => {
            emails.push(message)
            return {
              providerMessageId: "email-public-legacy",
              providerSentTo: "external@example.com",
            }
          }),
      }),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const now = yield* DateTime.now
        yield* notificationDeliveryHandler.handle({
          jobId: "job-notification-public-legacy-receipt-001",
          queue: NOTIFICATION_DELIVERY_QUEUE,
          payload: {
            channel: "email",
            recipient: {
              email: "external@example.com",
              displayName: "External Reviewer",
            },
            publicTodo: {
              todoId: "todo-123",
              processName: "Purchase approval",
              stepName: "External review",
              token: "public-token-123",
              expiresAt: "2026-05-01T10:00:00.000Z",
            },
          },
          attempts: 1,
          maxAttempts: 5,
          availableAt: now,
          lockedUntil: now,
        })
      }).pipe(Effect.provide(TestLayer)) as Effect.Effect<void>,
    )

    expect(emails).toHaveLength(1)
    expect(emails[0]?.tags).toBeUndefined()
  })

  it("does not fail delivery when receipt persistence fails after send", async () => {
    const emails: EmailMessage[] = []

    const TestLayer = Layer.mergeAll(
      Layer.succeed(NotificationDeliveryConfig, {
        getFrontendBaseUrl: () => "https://console.example.com",
        getEnvironment: () => "dev",
        getSenderIdentity: () => ({
          email: "notifications@example.com",
          name: "Process Focus",
        }),
      }),
      Layer.succeed(EmailSender, {
        send: (message) =>
          Effect.sync(() => {
            emails.push(message)
            return {
              providerMessageId: "email-public-456",
              providerSentTo: "external@example.com",
            }
          }),
      }),
      makeReceiptOpsLayer(() => Effect.fail(new Error("receipt write failed"))),
    )

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const now = yield* DateTime.now
          yield* notificationDeliveryHandler.handle({
            jobId: "job-notification-public-receipt-failure-001",
            queue: NOTIFICATION_DELIVERY_QUEUE,
            payload: {
              channel: "email",
              recipient: {
                email: "external@example.com",
                displayName: "External Reviewer",
              },
              publicTodo: {
                todoId: "todo-123",
                processName: "Purchase approval",
                stepName: "External review",
                token: "public-token-123",
                expiresAt: "2026-05-01T10:00:00.000Z",
                publicCompletionInvitationAttemptId: "pcia-456",
              },
            },
            attempts: 1,
            maxAttempts: 5,
            availableAt: now,
            lockedUntil: now,
          })
        }).pipe(Effect.provide(TestLayer)) as Effect.Effect<void>,
      ),
    ).resolves.toBeUndefined()
    expect(emails).toHaveLength(1)
  })

  it("renders an execution-failure email and delegates it to the sender", async () => {
    const emails: EmailMessage[] = []
    const longFailureReason = `${"Database connection timed out while contacting replica. ".repeat(12)}END`

    const TestLayer = Layer.mergeAll(
      Layer.succeed(NotificationDeliveryConfig, {
        getFrontendBaseUrl: () => "https://console.example.com",
        getEnvironment: () => undefined,
        getSenderIdentity: () => ({
          email: "notifications@example.com",
          name: "Process Focus",
        }),
      }),
      Layer.succeed(EmailSender, {
        send: (message) =>
          Effect.sync(() => {
            emails.push(message)
            return undefined
          }),
      }),
    )

    const program = Effect.gen(function* () {
      const now = yield* DateTime.now
      yield* notificationDeliveryHandler.handle({
        jobId: "job-notification-004",
        queue: NOTIFICATION_DELIVERY_QUEUE,
        payload: {
          channel: "email",
          recipient: {
            userId: "usr-456",
            email: "operator@example.com",
            displayName: "Olive Operator",
          },
          executionFailure: {
            executionId: "pex-123",
            processName: "Purchase approval",
            failureReason: longFailureReason,
            project: "acme",
            environment: "prod",
          },
        },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      })
    })

    await Effect.runPromise(
      program.pipe(Effect.provide(TestLayer)) as Effect.Effect<void>,
    )

    expect(emails).toHaveLength(1)
    expect(emails[0]).toEqual({
      to: "operator@example.com",
      from: "Process Focus <notifications@example.com>",
      subject: "[acme/prod] Fatal execution failure: Purchase approval",
      html: expect.stringContaining("Hello Olive Operator,"),
    })
    expect(emails[0]?.html).toContain("Purchase approval")
    expect(emails[0]?.html).toContain("acme/prod")
    expect(emails[0]?.html).toContain(
      "https://console.example.com/executions/pex-123",
    )
    expect(emails[0]?.html).toContain("Open execution")
    expect(emails[0]?.html).toContain("Database connection timed out")
    expect(emails[0]?.html).toContain("...")
    expect(emails[0]?.html).not.toContain("END")
  })

  it("skips delivery when notifications are not configured", async () => {
    let sendCalls = 0

    const TestLayer = Layer.mergeAll(
      Layer.succeed(NotificationDeliveryConfig, {
        getFrontendBaseUrl: () => "https://console.example.com",
        getEnvironment: () => undefined,
        getSenderIdentity: () => undefined,
      }),
      Layer.succeed(EmailSender, {
        send: () =>
          Effect.sync(() => {
            sendCalls++
            return undefined
          }),
      }),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const now = yield* DateTime.now
        yield* notificationDeliveryHandler.handle({
          jobId: "job-notification-003",
          queue: NOTIFICATION_DELIVERY_QUEUE,
          payload: {
            channel: "email",
            recipient: {
              userId: "usr-123",
              email: "person@example.com",
            },
            todo: {
              todoId: "todo-123",
              stepPath: "finance/purchase/finish",
              processName: "Purchase approval",
              stepName: "Finish purchase",
            },
          },
          attempts: 1,
          maxAttempts: 5,
          availableAt: now,
          lockedUntil: now,
        })
      }).pipe(Effect.provide(TestLayer)) as Effect.Effect<void>,
    )

    expect(sendCalls).toBe(0)
  })
})
