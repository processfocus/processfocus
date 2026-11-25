import { QueueService } from "@processfocus/runtime"
import type { Context } from "effect"
import {
  DateTime,
  Schema as ES,
  Effect,
  FileSystem,
  Layer,
  ManagedRuntime,
} from "effect"
import { graphql } from "graphql"
import { createSchema } from "graphql-yoga"
import { AuthorizationService, CurrentPrincipal } from "@pf/auth-policy"
import {
  CalendarSlotField,
  FormDefault,
  LookupField,
  ProviderUserField,
  RadioField,
} from "@pf/form-schema"
import { withFormRules } from "@pf/form-submission-schema"
import {
  BusinessCalendarQueries,
  type CompletedStepData,
  FlowExecutionOperations,
  NOTIFICATION_DELIVERY_QUEUE,
  OrgQueries,
  ProcessQueries,
  ProviderUserQueries,
  ScheduledFlowOperations,
  StepCompletionOperations,
  StepRoleQueries,
  UserDetails,
  WorkflowQueries,
} from "@pf/graphql-db-operations"
import {
  Form,
  NodeStep,
  OrgUnit,
  Organisation,
  OrganisationProvider,
  Process,
  Role,
  type StaticFormDeclaration,
} from "@pf/process"
import {
  PUBLIC_TODO_TOKEN_AUDIENCE,
  buildPublicTodoUrl,
  decryptPublicTodoToken,
  encryptPublicTodoToken,
} from "@pf/public-completion/credentials"
import { RequestTime } from "@pf/request-time"
import { transformSchemaWithAuthDirective } from "../src/lib/auth-directive-plugin"
import { createResolverExecutor } from "../src/lib/resolver-utils"
import { systemSchema } from "../src/lib/system-resolvers"
import type { UserContext } from "../src/lib/types"
import { afterAll, beforeAll, describe, expect, it } from "bun:test"

const SECRET = "public-todo-test-secret"
const originalPublicTodoTokenSecret = process.env["PUBLIC_TODO_TOKEN_SECRET"]

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
  _requestTime: DateTime.makeUnsafe("2026-04-06T10:00:00.000Z"),
  _userDetails: {
    by: "frontend",
    id: null,
  } as UserContext["_userDetails"],
  jwt: undefined,
  userId: "frontend",
})

const makeCiPipelineContext = (): UserContext => ({
  _requestTime: DateTime.makeUnsafe("2026-04-06T10:00:00.000Z"),
  _userDetails: {
    by: "ci-pipeline",
    id: null,
  } as UserContext["_userDetails"],
  jwt: {
    mode: "access",
    type: "user",
    properties: {
      userId: "ci-pipeline",
      clientId: "ci-pipeline",
    },
    aud: "graphql-api",
    iss: "http://localhost:4020",
    sub: "ci-pipeline",
    exp: 0,
    iat: 0,
  },
  userId: "ci-pipeline",
})

const makeOfficeStaffContext = (): UserContext => ({
  _requestTime: DateTime.makeUnsafe("2026-04-06T10:00:00.000Z"),
  _userDetails: {
    by: "office-staff-e2e@example.com",
    id: "usr-office",
  } as UserContext["_userDetails"],
  jwt: {
    mode: "access",
    type: "providerUser",
    properties: {
      userId: "usr-office",
      email: "office-staff-e2e@example.com",
      roles: ["/OfficeStaff"],
      orgUnitPath: "/",
      orgUnitId: "ou-root",
    },
    aud: "graphql-api",
    iss: "http://localhost:4020",
    sub: "providerUser:office-staff",
    exp: 0,
    iat: 0,
  },
  userId: "usr-office",
})

const makeToken = (
  todoId: string,
  exp: number,
  externalParticipantEmail?: string,
) =>
  Effect.runPromise(
    encryptPublicTodoToken(
      {
        v: 1,
        tid: todoId,
        ...(externalParticipantEmail ? { externalParticipantEmail } : {}),
        iat: 1_775_472_000,
        exp,
        aud: PUBLIC_TODO_TOKEN_AUDIENCE,
      },
      SECRET,
    ),
  )

const makeOrganisation = ({
  withForm = true,
  withPublicCompletion = true,
  withStringPublicCompletion = false,
  withIndependentLookup = false,
  localLookupCount,
  withDependentLookup = false,
  withLookupOverride = false,
  withPermissionLookup = false,
  withProviderUserField = false,
  withSchoolTourProjection = false,
}: {
  withForm?: boolean
  withPublicCompletion?: boolean
  withStringPublicCompletion?: boolean
  withIndependentLookup?: boolean
  localLookupCount?: number
  withDependentLookup?: boolean
  withLookupOverride?: boolean
  withPermissionLookup?: boolean
  withProviderUserField?: boolean
  withSchoolTourProjection?: boolean
} = {}) => {
  const org = new Organisation({ name: "Test Org" })
  const ops = new OrgUnit(org, "ops", {
    name: "Ops",
    type: "department",
  })
  const role = new Role(ops, "owner", { name: "Owner" })
  const process = new Process(ops, "todo", {
    name: "Todo",
    purpose: "Complete public todos",
  })
  if (!withForm) {
    const complete = new NodeStep(process, "Complete", {
      input: () => Effect.succeed({}),
      output: {},
      execute: () => Effect.succeed({}),
    })
    process.start(complete).end()
    return org
  }

  const start = new Form(process, "Start", {
    role,
    form: () => ({}),
  })
  const startFlow = process.start(start)
  if (withSchoolTourProjection) {
    const complete = new Form(startFlow, "Complete", {
      role,
      form: withFormRules(
        ES.Struct({
          waitingTourOutcome: ES.optional(
            RadioField({
              label: "Outcome",
              permission: { modify: role },
              options: [
                {
                  value: "scheduled-tour",
                  label: "Book a scheduled tour slot",
                },
                {
                  value: "tour-booked-manually",
                  label: "Tour booked manually",
                },
              ],
            }),
          ).annotate({ [FormDefault]: "scheduled-tour" }),
          selectedEnrolmentSlotEventId: ES.optional(
            CalendarSlotField({
              label: "Available school tour slots",
              timeZone: "Pacific/Auckland",
              locale: "en-NZ",
              query: () => Effect.succeed([]),
            }),
          ),
        }),
        (value) => ({
          selectedEnrolmentSlotEventId: {
            required: !value.selectedEnrolmentSlotEventId,
          },
        }),
        (value) =>
          value.waitingTourOutcome === "tour-booked-manually"
            ? {
                selectedEnrolmentSlotEventId: { hidden: true, required: false },
              }
            : {},
      ),
      publicCompletion: {
        recipient: () => "parent@example.com",
        expiresAt: () => DateTime.makeUnsafe("2026-04-07T10:00:00.000Z"),
      },
    })
    startFlow.end(complete)
    return org
  }
  const lookupPermissionOptions = withPermissionLookup
    ? { default: "class-1", permission: { modify: role } }
    : {}
  const makeComplete = <Fields extends ES.Struct.Fields>(
    form: () => StaticFormDeclaration<Fields>,
  ) => {
    const complete = new Form<
      NonNullable<typeof startFlow.__scopeState>,
      NonNullable<typeof startFlow.__scopeSteps>,
      Fields,
      "Complete"
    >(startFlow, "Complete", {
      role,
      form,
      ...(withPublicCompletion
        ? {
            publicCompletion: {
              recipient: () => ({
                email: "fresh@example.com",
                displayName: "Fresh Recipient",
              }),
              expiresAt: () => DateTime.makeUnsafe("2026-04-07T10:00:00.000Z"),
              subject: (_state, _ctx, _item, publicUrl) =>
                `Fresh invitation ${publicUrl}`,
              body: () => "Fresh invitation body",
              template: () => ({ id: "fresh-invitation-template" }),
              attachments: () => [
                {
                  filename: "permission.pdf",
                  storePrefix: "/permission-documents",
                  fileId: "file-permission-001",
                },
              ],
              formTitle: "Complete your public task",
              formDescription: "Fill in the details and submit this form.",
              thankYou: withStringPublicCompletion
                ? "Thanks. Your public to-do was submitted."
                : () =>
                    Effect.succeed("Thanks. Your public to-do was submitted."),
            },
          }
        : {}),
    })
    startFlow.end(complete)
    return complete
  }
  // Select a fixed, precisely typed schema before configuring its public accessors.
  ;(() => {
    if (withProviderUserField) {
      return makeComplete(() => ({
        classId: ProviderUserField({ label: "Class" }),
      }))
    }
    if (
      withDependentLookup ||
      localLookupCount !== undefined ||
      withIndependentLookup ||
      withLookupOverride ||
      withPermissionLookup
    ) {
      const lookupForm = makeComplete(() => ({
        campusId: LookupField({
          label: "Campus",
          query: () => Effect.succeed([{ value: "north", label: "North" }]),
        }),
        classId: LookupField({
          label: "Class",
          resolve: (value) =>
            Effect.succeed(
              value === "restored-class"
                ? { value, label: "Restored class" }
                : null,
            ),
          ...lookupPermissionOptions,
          ...(localLookupCount !== undefined
            ? { mode: "local", maxItems: 500 }
            : {}),
          query: (filter, limit) =>
            Effect.succeed(
              localLookupCount === undefined
                ? [{ value: "class-1", label: "Class 1" }]
                : Array.from({ length: localLookupCount }, (_, i) => ({
                    value: `class-${i}`,
                    label: `Class ${i}`,
                  }))
                    .filter((item) => item.label.includes(filter))
                    .slice(0, limit),
            ),
        }),
      }))
      if (withDependentLookup) {
        lookupForm.lookups.classId
          .dependsOn([lookupForm.lookups.campusId])
          .setQuery(() =>
            Effect.succeed([{ value: "class-1", label: "Class 1" }]),
          )
      }
      if (withLookupOverride) {
        lookupForm.lookups.classId.setQuery(() =>
          Effect.succeed([{ value: "class-1", label: "Class 1" }]),
        )
      }
      return lookupForm
    }
    return makeComplete(() => ({ comment: ES.String }))
  })()
  return org
}

const makeLayers = ({
  status,
  canComplete = true,
  withForm = true,
  withPublicCompletion = true,
  withStringPublicCompletion = false,
  withIndependentLookup = false,
  localLookupCount,
  withDependentLookup = false,
  withLookupOverride = false,
  withPermissionLookup = false,
  withProviderUserField = false,
  withSchoolTourProjection = false,
  enqueuedJobs,
  queueInTransaction = true,
  publicCompletionInvitationAttempts,
  latestPublicCompletionInvitationRecipientEmail = null,
  latestPublicCompletionInvitationAttempt = null,
  canAccessField = () => Effect.succeed(false),
}: {
  readonly status: "active" | "completed" | "unavailable"
  readonly canComplete?: boolean
  readonly withForm?: boolean
  readonly withPublicCompletion?: boolean
  readonly withStringPublicCompletion?: boolean
  readonly withIndependentLookup?: boolean
  readonly localLookupCount?: number
  readonly withDependentLookup?: boolean
  readonly withLookupOverride?: boolean
  readonly withPermissionLookup?: boolean
  readonly withProviderUserField?: boolean
  readonly withSchoolTourProjection?: boolean
  readonly enqueuedJobs?: Array<{
    readonly queue: string
    readonly payload: unknown
  }>
  readonly queueInTransaction?: boolean
  readonly publicCompletionInvitationAttempts?: Array<{
    readonly todoId: string
    readonly recipientEmail: string
  }>
  readonly latestPublicCompletionInvitationRecipientEmail?: string | null
  readonly latestPublicCompletionInvitationAttempt?: {
    readonly id: string
    readonly email: string
  } | null
  readonly canAccessField?: Context.Service.Shape<
    typeof AuthorizationService
  >["canAccessField"]
}) =>
  Layer.mergeAll(
    Layer.succeed(FileSystem.FileSystem, {
      readFileString: () => Effect.succeed("type Query { _: Boolean }"),
    } as unknown as FileSystem.FileSystem),
    Layer.succeed(
      OrgQueries,
      {} as unknown as Context.Service.Shape<typeof OrgQueries>,
    ),
    Layer.succeed(
      ProcessQueries,
      {} as unknown as Context.Service.Shape<typeof ProcessQueries>,
    ),
    Layer.succeed(
      ProviderUserQueries,
      {} as unknown as Context.Service.Shape<typeof ProviderUserQueries>,
    ),
    Layer.succeed(
      WorkflowQueries,
      {} as unknown as Context.Service.Shape<typeof WorkflowQueries>,
    ),
    Layer.succeed(StepRoleQueries, {
      queryRolePathsByStepPath: () =>
        Effect.succeed({
          rolePath: "/ops/owner",
          supportingRolePaths: [],
          startsProcess: false,
          embedded: false,
        }),
    } as unknown as Context.Service.Shape<typeof StepRoleQueries>),
    Layer.succeed(BusinessCalendarQueries, {
      getCalendarData: () => Effect.succeed(new Map()),
    } as unknown as Context.Service.Shape<typeof BusinessCalendarQueries>),
    Layer.succeed(FlowExecutionOperations, {
      getProcessIdForExecution: () => Effect.succeed("proc-1"),
    } as unknown as Context.Service.Shape<typeof FlowExecutionOperations>),
    Layer.succeed(ScheduledFlowOperations, {
      insertScheduledFlow: () => Effect.succeed("sf-1"),
    } as unknown as Context.Service.Shape<typeof ScheduledFlowOperations>),
    Layer.succeed(QueueService, {
      queueInTransaction,
      enqueue: (queue: string, payload: unknown) =>
        Effect.sync(() => {
          enqueuedJobs?.push({ queue, payload })
          return `job-${enqueuedJobs?.length ?? 0}`
        }),
    } as unknown as Context.Service.Shape<typeof QueueService>),
    Layer.succeed(RequestTime, DateTime.makeUnsafe("2026-04-06T10:00:00.000Z")),
    Layer.succeed(UserDetails, { by: "frontend", id: null }),
    Layer.succeed(OrganisationProvider, {
      organisation: makeOrganisation({
        withForm,
        withPublicCompletion,
        withStringPublicCompletion,
        withIndependentLookup,
        ...(localLookupCount !== undefined && { localLookupCount }),
        withDependentLookup,
        withLookupOverride,
        withPermissionLookup,
        withProviderUserField,
        withSchoolTourProjection,
      }),
      orgPath: "/tmp/org",
      schemaPath: "/tmp/org.graphql",
    }),
    Layer.succeed(AuthorizationService, {
      canIssueDelegationSecret: () => Effect.succeed(false),
      canListDelegationTokens: () => Effect.succeed(false),
      canManageDelegation: () => Effect.succeed(false),
      canLogin: () => Effect.succeed(false),
      policyVersion: Effect.succeed("test-policy"),
      canCompleteStep: (principal) =>
        Effect.succeed(principal.uid.type === "PF::PublicLink" && canComplete),
      canViewEmbeddedForm: () => Effect.succeed(false),
      canCorrectPublicCompletionTodo: () => Effect.succeed(false),
      canModifyField: () => Effect.succeed(false),
      canRequestRole: () => Effect.succeed(false),
      canActOnBehalfOf: () => Effect.succeed(false),
      canViewExecution: () => Effect.succeed(false),
      canRestartExecution: () => Effect.succeed(false),
      canAbandonStep: () => Effect.succeed(false),
      canDraftStep: () => Effect.succeed(false),
      canAccessField,
      canAccessFeature: () => Effect.succeed(false),
      canAccessList: () => Effect.succeed(false),
      canCreateList: () => Effect.succeed(false),
      canUpdateList: () => Effect.succeed(false),
      canDeleteList: () => Effect.succeed(false),
      canDownloadFile: () => Effect.succeed(false),
      canDeleteFile: () => Effect.succeed(false),
      canPerformAction: () => Effect.succeed(false),
    }),
    Layer.succeed(StepCompletionOperations, {
      queryPublicTodoInfo: (todoId: string) =>
        Effect.succeed({
          todoId,
          status,
          stepPath: status === "unavailable" ? null : "/ops/todo/Complete",
          latestPublicCompletionInvitationRecipientEmail,
          itemData: null,
        }),
      queryLatestPublicCompletionInvitationAttempt: () =>
        Effect.succeed(latestPublicCompletionInvitationAttempt),
      createPublicCompletionInvitationAttempt: (input: {
        readonly todoId: string
        readonly recipientEmail: string
      }) =>
        Effect.sync(() => {
          publicCompletionInvitationAttempts?.push(input)
          return `pcia-${input.todoId}`
        }),
      recordPublicCompletionInvitationAttemptReceipt: () =>
        Effect.succeed(true),
      getProcessStateByTodoId: () =>
        Effect.succeed({
          processExecutionId: "pex-1",
          processStateId: "pst-1",
          state: {},
          processStartedAt: DateTime.makeUnsafe("2026-04-06T09:00:00.000Z"),
        }),
      getCompletedStepsForExecution: () =>
        Effect.succeed([] satisfies CompletedStepData[]),
      queryTodoById: (todoId: string) =>
        Effect.succeed({
          id: todoId,
          processExecutionId: "pex-1",
          processStateId: "pst-1",
          startedByUserId: null,
          targetStepId: "step-1",
          targetStepPath: "/ops/todo/Complete",
          createdAtMs: Date.UTC(2026, 3, 6, 9),
          orgUnitId: "ops",
          itemData: null,
          hasForEach: false,
          barrierScheduledFlowId: null,
        }),
      queryTodoForCompletionById: (todoId: string) =>
        Effect.succeed({
          id: todoId,
          targetStepPath: "/ops/todo/Complete",
          processPath: "/ops/todo",
          orgUnitPath: "/ops",
          assignedToProviderUserEmail: null,
        }),
    } as unknown as Context.Service.Shape<typeof StepCompletionOperations>),
  )

const resolvePublicTodo = async (
  token: string,
  layers: ReturnType<typeof makeLayers>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const schema = yield* systemSchema
      const resolver = schema.resolvers?.Query?.["publicTodo"] as unknown as (
        parent: unknown,
        args: { token: string },
        context: UserContext,
      ) => Effect.Effect<Record<string, unknown>, unknown>

      return yield* resolver(undefined, { token }, makeContext())
    }).pipe(Effect.provide(layers)),
  )

const resolvePublicCompletionUrl = async (
  todoId: string,
  layers: ReturnType<typeof makeLayers>,
  context: UserContext = makeContext(),
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const schema = yield* systemSchema
      const resolver = schema.resolvers?.Query?.[
        "publicCompletionUrl"
      ] as unknown as (
        parent: unknown,
        args: { todoId: string },
        context: UserContext,
      ) => Effect.Effect<string, unknown>

      return yield* resolver(undefined, { todoId }, context)
    }).pipe(Effect.provide(layers)),
  )

const queryPublicCompletionUrlWithAuth = async (
  todoId: string,
  layers: ReturnType<typeof makeLayers>,
  context: UserContext,
) => {
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(layers, Layer.succeed(CurrentPrincipal, null)),
  )

  try {
    const definition = await runtime.runPromise(systemSchema)
    const resolver = definition.resolvers?.Query?.["publicCompletionUrl"]
    const baseSchema = createSchema({
      typeDefs: /* GraphQL */ `
        directive @auth(tag: String, action: String) on FIELD_DEFINITION
        type Query {
          publicCompletionUrl(todoId: ID!): String! @auth(tag: "ci")
        }
      `,
      resolvers: {
        Query: {
          publicCompletionUrl: resolver,
        },
      },
    })
    const executor = createResolverExecutor(runtime)
    const schema = transformSchemaWithAuthDirective(baseSchema, executor)
    return await graphql({
      schema,
      source:
        "query PublicCompletionUrl($todoId: ID!) { publicCompletionUrl(todoId: $todoId) }",
      variableValues: { todoId },
      contextValue: context,
    })
  } finally {
    await runtime.dispose()
  }
}

const completePublicTodo = async (
  token: string,
  layers: ReturnType<typeof makeLayers>,
  input: Record<string, unknown> = {},
) =>
  Effect.runPromise(
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
    }).pipe(Effect.provide(layers)),
  )

const publicTodoLookupSuggestions = async (
  token: string,
  layers: ReturnType<typeof makeLayers>,
  field: string,
  options: { filter?: string; limit?: number; selectedValue?: string } = {},
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const schema = yield* systemSchema
      const resolver = schema.resolvers?.Query?.[
        "publicTodoLookupSuggestions"
      ] as unknown as (
        parent: unknown,
        args: { token: string; field: string; filter?: string; limit?: number },
        context: UserContext,
      ) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, unknown>

      return yield* resolver(
        undefined,
        { token, field, ...options },
        makeContext(),
      )
    }).pipe(Effect.provide(layers)),
  )

const requestFreshPublicTodoLink = async (
  token: string,
  layers: ReturnType<typeof makeLayers>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const schema = yield* systemSchema
      const resolver = schema.resolvers?.Mutation?.[
        "requestFreshPublicTodoLink"
      ] as unknown as (
        parent: unknown,
        args: { token: string },
        context: UserContext,
      ) => Effect.Effect<Record<string, unknown>, unknown>

      return yield* resolver(undefined, { token }, makeContext())
    }).pipe(Effect.provide(layers)),
  )

describe("public todo GraphQL capability", () => {
  it("returns completed even when the token is expired", async () => {
    const token = await makeToken("todo-1", 1)

    const result = await resolvePublicTodo(
      token,
      makeLayers({ status: "completed" }),
    )

    expect(result).toMatchObject({ todoId: "todo-1", status: "COMPLETED" })
  })

  it("returns expired for an expired active todo", async () => {
    const token = await makeToken("todo-1", 1)

    const result = await resolvePublicTodo(
      token,
      makeLayers({ status: "active" }),
    )

    expect(result).toMatchObject({ todoId: "todo-1", status: "EXPIRED" })
  })

  it("returns active todo form metadata for a valid token", async () => {
    const token = await makeToken("todo-1", 1_775_558_000)

    const result = await resolvePublicTodo(
      token,
      makeLayers({ status: "active" }),
    )

    expect(result).toMatchObject({
      todoId: "todo-1",
      status: "ACTIVE",
      formMetadata: {
        stepPath: "/ops/todo/Complete",
        processName: "Todo",
        publicFormTitle: "Complete your public task",
        publicFormDescription: "Fill in the details and submit this form.",
        processPath: "ops/todo",
        completeMutationName: "completeOpsTodoComplete",
        defaultValues: expect.any(Object),
      },
    })
  })

  it("returns one authorized school-tour definition without staff-only data", async () => {
    const token = await makeToken("todo-1", 1_775_558_000)

    const result = await resolvePublicTodo(
      token,
      makeLayers({
        status: "active",
        withSchoolTourProjection: true,
      }),
    )
    const formMetadata = result["formMetadata"] as {
      readonly defaultValues: Record<string, unknown>
      readonly requestData: { readonly inaccessible: readonly string[] }
    }
    expect(formMetadata.defaultValues).not.toHaveProperty("waitingTourOutcome")
    expect(formMetadata.requestData.inaccessible).toContain(
      "waitingTourOutcome",
    )
  })

  it("returns unavailable when an active token predates the latest invitation", async () => {
    const token = await makeToken("todo-1", 1_775_558_000)

    const result = await resolvePublicTodo(
      token,
      makeLayers({
        status: "active",
        latestPublicCompletionInvitationRecipientEmail: "fresh@example.com",
      }),
    )

    expect(result).toMatchObject({ todoId: "todo-1", status: "UNAVAILABLE" })
  })

  it("returns active when the token recipient matches the latest invitation", async () => {
    const token = await makeToken(
      "todo-1",
      1_775_558_000,
      " FRESH@example.com ",
    )

    const result = await resolvePublicTodo(
      token,
      makeLayers({
        status: "active",
        latestPublicCompletionInvitationRecipientEmail: "fresh@example.com",
      }),
    )

    expect(result).toMatchObject({ todoId: "todo-1", status: "ACTIVE" })
  })

  it("returns unavailable when the token recipient differs from the latest invitation", async () => {
    const token = await makeToken("todo-1", 1_775_558_000, "old@example.com")

    const result = await resolvePublicTodo(
      token,
      makeLayers({
        status: "active",
        latestPublicCompletionInvitationRecipientEmail: "fresh@example.com",
      }),
    )

    expect(result).toMatchObject({ todoId: "todo-1", status: "UNAVAILABLE" })
  })

  it("expires a token at the current request second", async () => {
    const token = await makeToken("todo-1", 1_775_469_600)

    const result = await resolvePublicTodo(
      token,
      makeLayers({ status: "active" }),
    )

    expect(result).toMatchObject({ todoId: "todo-1", status: "EXPIRED" })
  })

  it("returns suggestions for independent public lookup fields", async () => {
    const token = await makeToken("todo-1", 1_775_558_000)

    await expect(
      publicTodoLookupSuggestions(
        token,
        makeLayers({ status: "active", withIndependentLookup: true }),
        "classId",
      ),
    ).resolves.toEqual([{ value: "class-1", label: "Class 1" }])
  })

  it("returns complete bounded local public choices and an overflow sentinel", async () => {
    const token = await makeToken("todo-1", 1_775_558_000)
    for (const count of [500, 501, 600]) {
      const items = await publicTodoLookupSuggestions(
        token,
        makeLayers({ status: "active", localLookupCount: count }),
        "classId",
        { limit: 501 },
      )
      expect(items).toHaveLength(Math.min(count, 501))
      expect(items[499]).toEqual({ value: "class-499", label: "Class 499" })
    }
    await expect(
      publicTodoLookupSuggestions(
        token,
        makeLayers({ status: "active", localLookupCount: 500 }),
        "classId",
        { filter: "does not match", limit: 20 },
      ),
    ).resolves.toHaveLength(500)
    await expect(
      publicTodoLookupSuggestions(
        token,
        makeLayers({ status: "completed", localLookupCount: 501 }),
        "classId",
      ),
    ).resolves.toEqual([])
  })

  it("resolves a public selection independently while preserving capability and field restrictions", async () => {
    const token = await makeToken("todo-1", 1_775_558_000)
    const options = { selectedValue: "restored-class" }
    await expect(
      publicTodoLookupSuggestions(
        token,
        makeLayers({ status: "active", withIndependentLookup: true }),
        "classId",
        options,
      ),
    ).resolves.toEqual([{ value: "restored-class", label: "Restored class" }])
    await expect(
      publicTodoLookupSuggestions(
        token,
        makeLayers({ status: "active", withIndependentLookup: true }),
        "classId",
        { selectedValue: "unavailable" },
      ),
    ).resolves.toEqual([])
    await expect(
      publicTodoLookupSuggestions(
        token,
        makeLayers({ status: "completed", withIndependentLookup: true }),
        "classId",
        options,
      ),
    ).resolves.toEqual([])
    for (const restricted of [
      { withDependentLookup: true },
      { withLookupOverride: true },
      { withPermissionLookup: true },
      { withProviderUserField: true },
    ]) {
      await expect(
        publicTodoLookupSuggestions(
          token,
          makeLayers({ status: "active", ...restricted }),
          "classId",
          options,
        ),
      ).rejects.toThrow("not authorized")
    }
  })

  it("returns no lookup suggestions for completed public todos", async () => {
    const token = await makeToken("todo-1", 1_775_558_000)

    await expect(
      publicTodoLookupSuggestions(
        token,
        makeLayers({ status: "completed", withIndependentLookup: true }),
        "classId",
      ),
    ).resolves.toEqual([])
  })

  it("rejects dependent lookup fields for public todos", async () => {
    const token = await makeToken("todo-1", 1_775_558_000)

    await expect(
      publicTodoLookupSuggestions(
        token,
        makeLayers({ status: "active", withDependentLookup: true }),
        "classId",
      ),
    ).rejects.toThrow("Public dependent lookup field classId is not authorized")
  })

  it("rejects public lookup fields with lookup overrides", async () => {
    const token = await makeToken("todo-1", 1_775_558_000)

    await expect(
      publicTodoLookupSuggestions(
        token,
        makeLayers({ status: "active", withLookupOverride: true }),
        "classId",
      ),
    ).rejects.toThrow("Public lookup field classId is not authorized")
  })

  it("cannot resolve a public lookup component omitted by authorization", async () => {
    const token = await makeToken("todo-1", 1_775_558_000)

    await expect(
      publicTodoLookupSuggestions(
        token,
        makeLayers({ status: "active", withPermissionLookup: true }),
        "classId",
      ),
    ).rejects.toThrow("Public lookup field classId is not authorized")
  })

  it("rejects provider-user public lookup fields", async () => {
    const token = await makeToken("todo-1", 1_775_558_000)

    await expect(
      publicTodoLookupSuggestions(
        token,
        makeLayers({ status: "active", withProviderUserField: true }),
        "classId",
      ),
    ).rejects.toThrow(
      "Public provider-user lookup field classId is not authorized",
    )
  })

  it("returns completed from the complete mutation for completed todos", async () => {
    const token = await makeToken("todo-1", 1)

    const result = await completePublicTodo(
      token,
      makeLayers({ status: "completed" }),
    )

    expect(result).toMatchObject({ todoId: "todo-1", status: "COMPLETED" })
  })

  it("does not recover a completed todo from an old recipient token", async () => {
    const token = await makeToken("todo-1", 1_775_558_000, "old@example.com")

    const result = await completePublicTodo(
      token,
      makeLayers({
        status: "completed",
        latestPublicCompletionInvitationRecipientEmail: "current@example.com",
      }),
    )

    expect(result).toMatchObject({ todoId: "todo-1", status: "UNAVAILABLE" })
  })

  it("returns expired from the complete mutation for expired active todos", async () => {
    const token = await makeToken("todo-1", 1)

    const result = await completePublicTodo(
      token,
      makeLayers({ status: "active" }),
    )

    expect(result).toMatchObject({ todoId: "todo-1", status: "EXPIRED" })
  })

  it("sends a fresh link for an expired active public todo", async () => {
    const enqueuedJobs: Array<{
      readonly queue: string
      readonly payload: unknown
    }> = []
    const publicCompletionInvitationAttempts: Array<{
      readonly todoId: string
      readonly recipientEmail: string
    }> = []
    const token = await makeToken("todo-1", 1)

    const result = await requestFreshPublicTodoLink(
      token,
      makeLayers({
        status: "active",
        enqueuedJobs,
        queueInTransaction: false,
        publicCompletionInvitationAttempts,
      }),
    )

    expect(result).toMatchObject({ todoId: "todo-1", status: "ACTIVE" })
    expect(enqueuedJobs).toHaveLength(1)
    expect(enqueuedJobs[0]?.queue).toBe(NOTIFICATION_DELIVERY_QUEUE)
    expect(enqueuedJobs[0]?.payload).toMatchObject({
      channel: "email",
      recipient: {
        email: "fresh@example.com",
        displayName: "Fresh Recipient",
      },
      publicTodo: {
        todoId: "todo-1",
        processName: "Todo",
        stepName: "Complete",
        expiresAt: "2026-04-07T10:00:00.000Z",
        publicCompletionInvitationAttemptId: "pcia-todo-1",
        subject: expect.stringContaining(
          "Fresh invitation http://localhost:3000/public/form/",
        ),
        body: "Fresh invitation body",
        template: { id: "fresh-invitation-template" },
        attachments: [
          {
            filename: "permission.pdf",
            storePrefix: "/permission-documents",
            fileId: "file-permission-001",
          },
        ],
      },
    })
    expect(publicCompletionInvitationAttempts).toEqual([
      { todoId: "todo-1", recipientEmail: "fresh@example.com" },
    ])
    const enqueuedJob = enqueuedJobs[0]
    if (!enqueuedJob) throw new Error("Expected a public todo job")
    expect(
      (enqueuedJob.payload as { publicTodo?: { token?: unknown } }).publicTodo
        ?.token,
    ).toEqual(expect.any(String))
    const freshToken = (
      enqueuedJob.payload as {
        publicTodo?: { token?: string }
      }
    ).publicTodo?.token
    expect(freshToken).toBeDefined()
    const freshPayload = await Effect.runPromise(
      decryptPublicTodoToken(freshToken ?? "", SECRET),
    )
    expect(freshPayload).toMatchObject({
      tid: "todo-1",
      publicCompletionInvitationAttemptId: "pcia-todo-1",
      iat: 1_775_469_600,
      exp: 1_775_556_000,
    })
  })

  it("returns completed without resending when requesting a fresh link for a completed todo", async () => {
    const enqueuedJobs: Array<{
      readonly queue: string
      readonly payload: unknown
    }> = []
    const token = await makeToken("todo-1", 1)

    const result = await requestFreshPublicTodoLink(
      token,
      makeLayers({ status: "completed", enqueuedJobs }),
    )

    expect(result).toMatchObject({ todoId: "todo-1", status: "COMPLETED" })
    expect(enqueuedJobs).toEqual([])
  })

  it("returns unavailable without resending when public completion is no longer configured", async () => {
    const enqueuedJobs: Array<{
      readonly queue: string
      readonly payload: unknown
    }> = []
    const token = await makeToken("todo-1", 1)

    const result = await requestFreshPublicTodoLink(
      token,
      makeLayers({
        status: "active",
        withPublicCompletion: false,
        enqueuedJobs,
      }),
    )

    expect(result).toMatchObject({ todoId: "todo-1", status: "UNAVAILABLE" })
    expect(enqueuedJobs).toEqual([])
  })

  it("returns unavailable without resending when requesting a fresh link for an unavailable todo", async () => {
    const enqueuedJobs: Array<{
      readonly queue: string
      readonly payload: unknown
    }> = []
    const token = await makeToken("missing-todo", 1)

    const result = await requestFreshPublicTodoLink(
      token,
      makeLayers({ status: "unavailable", enqueuedJobs }),
    )

    expect(result).toMatchObject({
      todoId: "missing-todo",
      status: "UNAVAILABLE",
    })
    expect(enqueuedJobs).toEqual([])
  })

  it("rejects malformed tokens when requesting a fresh link", async () => {
    await expect(
      requestFreshPublicTodoLink(
        "not-a-token",
        makeLayers({ status: "active" }),
      ),
    ).rejects.toThrow()
  })

  it("returns unavailable from the complete mutation for unavailable todos", async () => {
    const token = await makeToken("todo-1", 1_775_558_000)

    const result = await completePublicTodo(
      token,
      makeLayers({ status: "unavailable" }),
    )

    expect(result).toMatchObject({ todoId: "todo-1", status: "UNAVAILABLE" })
  })

  it("returns unavailable when the token todo does not exist", async () => {
    const token = await makeToken("missing-todo", 1_775_558_000)

    const result = await resolvePublicTodo(
      token,
      makeLayers({ status: "unavailable" }),
    )

    expect(result).toMatchObject({
      todoId: "missing-todo",
      status: "UNAVAILABLE",
    })
  })

  it("returns unavailable for active public todos without a form", async () => {
    const token = await makeToken("todo-1", 1_775_558_000)
    const layers = makeLayers({
      status: "active",
      withForm: false,
    })

    const queryResult = await resolvePublicTodo(token, layers)
    const mutationResult = await completePublicTodo(token, layers)

    expect(queryResult).toMatchObject({
      todoId: "todo-1",
      status: "UNAVAILABLE",
    })
    expect(mutationResult).toMatchObject({
      todoId: "todo-1",
      status: "UNAVAILABLE",
    })
  })

  it("rejects Cedar-denied complete mutation calls", async () => {
    const token = await makeToken("todo-1", 1_775_558_000)

    await expect(
      completePublicTodo(
        token,
        makeLayers({ status: "active", canComplete: false }),
      ),
    ).rejects.toThrow(
      "This public link is not authorized to complete this todo",
    )
  })

  it("rejects malformed tokens", async () => {
    await expect(
      resolvePublicTodo("not-a-token", makeLayers({ status: "active" })),
    ).rejects.toThrow()
  })

  it("rejects wrong-secret tokens", async () => {
    const token = await Effect.runPromise(
      encryptPublicTodoToken(
        {
          v: 1,
          tid: "todo-1",
          iat: 1_775_472_000,
          exp: 1_775_558_000,
          aud: PUBLIC_TODO_TOKEN_AUDIENCE,
        },
        "wrong-secret",
      ),
    )

    await expect(
      resolvePublicTodo(token, makeLayers({ status: "active" })),
    ).rejects.toThrow()
  })

  it("rejects Cedar-denied active todos", async () => {
    const token = await makeToken("todo-1", 1_775_558_000)

    await expect(
      resolvePublicTodo(
        token,
        makeLayers({ status: "active", canComplete: false }),
      ),
    ).rejects.toThrow(
      "This public link is not authorized to complete this todo",
    )
  })

  it("remints a usable public completion URL from the latest invitation", async () => {
    const originalFrontendBaseUrl = process.env["FRONTEND_BASE_URL"]
    process.env["FRONTEND_BASE_URL"] = "https://console.example.com"

    try {
      const url = await resolvePublicCompletionUrl(
        "todo-1",
        makeLayers({
          status: "active",
          latestPublicCompletionInvitationAttempt: {
            id: "pcia-1",
            email: "parent@example.com",
          },
        }),
      )
      const token = decodeURIComponent(
        new URL(url).pathname.split("/").pop() ?? "",
      )
      expect(url).toBe(buildPublicTodoUrl("https://console.example.com", token))

      const payload = await Effect.runPromise(
        decryptPublicTodoToken(token, SECRET),
      )
      expect(payload.tid).toBe("todo-1")
      expect(payload.externalParticipantEmail).toBe("parent@example.com")
      expect(payload.publicCompletionInvitationAttemptId).toBe("pcia-1")
      expect(payload.exp).toBe(
        Math.floor(
          DateTime.toEpochMillis(
            DateTime.makeUnsafe("2026-04-07T10:00:00.000Z"),
          ) / 1000,
        ),
      )
    } finally {
      if (originalFrontendBaseUrl === undefined) {
        delete process.env["FRONTEND_BASE_URL"]
      } else {
        process.env["FRONTEND_BASE_URL"] = originalFrontendBaseUrl
      }
    }
  })

  it("fails to remint a public completion URL when no invitation exists", async () => {
    await expect(
      resolvePublicCompletionUrl("todo-1", makeLayers({ status: "active" })),
    ).rejects.toThrow("No public completion invitation exists")
  })

  it("denies publicCompletionUrl for a non-ci-pipeline principal", async () => {
    const originalFrontendBaseUrl = process.env["FRONTEND_BASE_URL"]
    process.env["FRONTEND_BASE_URL"] = "https://console.example.com"

    try {
      const layers = makeLayers({
        status: "active",
        latestPublicCompletionInvitationAttempt: {
          id: "pcia-1",
          email: "parent@example.com",
        },
        canAccessField: (principal) =>
          Effect.succeed(
            principal.uid.type === "PF::ServiceAccount" &&
              principal.uid.id === "ci-pipeline",
          ),
      })

      const denied = await queryPublicCompletionUrlWithAuth(
        "todo-1",
        layers,
        makeOfficeStaffContext(),
      )
      expect(denied.errors?.[0]?.message).toContain("Not authorized")
      expect(denied.errors?.[0]?.message).toContain(
        "office-staff-e2e@example.com",
      )
      expect(typeof denied.data?.["publicCompletionUrl"]).not.toBe("string")

      const allowed = await queryPublicCompletionUrlWithAuth(
        "todo-1",
        layers,
        makeCiPipelineContext(),
      )
      expect(allowed.errors).toBeUndefined()
      expect(typeof allowed.data?.["publicCompletionUrl"]).toBe("string")
      expect(String(allowed.data?.["publicCompletionUrl"])).toContain(
        "/public/form/",
      )
    } finally {
      if (originalFrontendBaseUrl === undefined) {
        delete process.env["FRONTEND_BASE_URL"]
      } else {
        process.env["FRONTEND_BASE_URL"] = originalFrontendBaseUrl
      }
    }
  })
})
