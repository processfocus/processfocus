import { readFileSync } from "node:fs"
import type { Context } from "effect"
import {
  DateTime,
  Schema as ES,
  Effect,
  FileSystem,
  Layer,
  Logger,
  ManagedRuntime,
  Option,
} from "effect"
import { graphql } from "graphql"
import { createSchema } from "graphql-yoga"
import {
  LocalCedarAuthorizationLive,
  LocalCedarConfig,
  getDefaultPoliciesPath,
  getDefaultSchemaPath,
} from "@pf/auth-local-cedar"
import { AuthorizationService, CurrentPrincipal } from "@pf/auth-policy"
import {
  CurrentProviderUser,
  LookupField,
  ProviderUserField,
  TextField,
  Wrapper,
  searchLookupItems,
} from "@pf/form-schema"
import {
  OrgQueries,
  type ProcessListRow,
  ProcessQueries,
  ProviderUserQueries,
  type ProviderUserRow,
  StepCompletionOperations,
  StepRoleQueries,
  UserDetails,
  WorkflowQueries,
} from "@pf/graphql-db-operations"
import { NotAuthorized } from "@pf/graphql-schema"
import {
  Form,
  List,
  NodeStep,
  OrgUnit,
  Organisation,
  OrganisationProvider,
  Process,
  Role,
  normalizePath,
} from "@pf/process"
import { transformSchemaWithAuthDirective } from "../src/lib/auth-directive-plugin"
import { dynamicSchema } from "../src/lib/dynamic-resolvers"
import { DynamicSchemaConfig } from "../src/lib/graphql-api"
import { createResolverExecutor } from "../src/lib/resolver-utils"
import { systemSchema } from "../src/lib/system-resolvers"
import type { UserContext } from "../src/lib/types"
import { describe, expect, it } from "bun:test"

it("authorizes embedded metadata through real Cedar without exposing ordinary forms or Todo state", async () => {
  const org = new Organisation({ name: "Embed authorization" })
  const role = new Role(org, "Employee")
  const process = new Process(org, "enquiry", {
    name: "Enquiry",
    purpose: "Test",
  })
  const form = new Form(process, "Submit", {
    role,
    embed: {
      externalParticipantEmailField: "email",
      sites: ["https://school.example"],
      thankYou: "Thanks",
    },
    form: () => ({
      email: TextField({ label: "Email", default: "public@example.com" }),
    }),
  })
  process.start(form).end()
  const stepPath = normalizePath(form.node.path)
  const context = makeServiceAccountContext()
  if (!context.jwt) throw new Error("Missing test session")
  context.jwt.properties = {
    userId: "frontend",
    clientId: "frontend",
    roles: [],
  }
  let embedded = true
  let startsProcess = true
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      makeLayers(org),
      Layer.succeed(CurrentPrincipal, null),
      Layer.succeed(UserDetails, context._userDetails),
      LocalCedarAuthorizationLive.pipe(
        Layer.provide(
          Layer.succeed(LocalCedarConfig, {
            schemaText: readFileSync(getDefaultSchemaPath(), "utf8"),
            policiesText: [
              readFileSync(getDefaultPoliciesPath(), "utf8"),
              'forbid(principal == PF::ServiceAccount::"frontend", action == PF::Action::"complete", resource);',
            ],
          }),
        ),
      ),
      Layer.succeed(StepRoleQueries, {
        queryRolePathsByStepPath: () =>
          Effect.succeed({
            rolePath: "/Employee",
            supportingRolePaths: [],
            embedded,
            startsProcess,
          }),
        queryRolePathsByStepPaths: () => Effect.succeed(new Map()),
        queryRoleIdByPath: () => Effect.succeed(undefined),
      }),
    ),
  )
  try {
    const definition = await runtime.runPromise(systemSchema)
    const schema = transformSchemaWithAuthDirective(
      createSchema({
        typeDefs: [
          readFileSync(
            new URL(
              "../../graphql-schema/graphql/system.graphql",
              import.meta.url,
            ),
            "utf8",
          ),
          readFileSync(
            new URL(
              "../../graphql-schema/graphql/rxdb.graphql",
              import.meta.url,
            ),
            "utf8",
          ),
          'directive @step(path: String!) on FIELD_DEFINITION\nextend type Query { boundLookup: String @step(path: "/enquiry/Submit") }',
        ],
        resolvers: {
          ...definition.resolvers,
          Query: {
            ...definition.resolvers?.Query,
            boundLookup: () => Effect.succeed("public option"),
          },
        },
      }),
      createResolverExecutor(runtime),
    )
    const execute = (source: string) =>
      graphql({
        schema,
        source,
        variableValues: { stepPath },
        contextValue: context,
      })
    const query =
      "query($stepPath: String!) { embeddedFormMetadata(stepPath: $stepPath) { defaultValues } }"
    const allowed = await execute(query)
    expect(allowed.errors).toBeUndefined()
    expect(allowed.data).toMatchObject({
      embeddedFormMetadata: { defaultValues: { email: "public@example.com" } },
    })
    expect((await execute("{ boundLookup }")).data).toMatchObject({
      boundLookup: "public option",
    })
    embedded = false
    const internal = await execute(query)
    expect(internal.errors?.[0]?.extensions["code"]).toBe("NotAuthorized")
    expect(
      (await execute("{ boundLookup }")).errors?.[0]?.extensions["code"],
    ).toBe("NotAuthorized")
    embedded = true
    startsProcess = false
    const continuation = await execute(query)
    expect(continuation.errors?.[0]?.extensions["code"]).toBe("NotAuthorized")
    startsProcess = true
    const ordinary = await execute(
      "query($stepPath: String!) { formMetadata(stepPath: $stepPath) { defaultValues } }",
    )
    expect(ordinary.errors?.[0]?.extensions["code"]).toBe("NotAuthorized")
    const todo = await execute(
      'query($stepPath: String!) { embeddedFormMetadata(stepPath: $stepPath, todoId: "private-todo") { defaultValues } }',
    )
    expect(todo.errors?.[0]?.message).toContain('Unknown argument "todoId"')
  } finally {
    await runtime.dispose()
  }
})

const makeContext = (
  roles: readonly string[] = ["/Administrator"],
): UserContext => ({
  _requestTime: DateTime.makeUnsafe("2026-04-06T10:00:00.000Z"),
  _userDetails: {
    by: "current@example.com",
    id: "current@example.com",
  } as UserContext["_userDetails"],
  jwt: {
    mode: "access",
    type: "user",
    properties: {
      userId: "current@example.com",
      email: "current@example.com",
      roles: roles.map(normalizePath),
      orgUnitPath: "/operations",
      orgUnitId: "/operations",
    },
    aud: "graphql-api",
    iss: "http://localhost:4020",
    sub: "current@example.com",
    exp: 0,
    iat: 0,
  },
  userId: "current@example.com",
})

it("searches authorized lookup labels and authored text, reports truncation and preserves dependent local completeness", async () => {
  const org = new Organisation({ name: "Search contract" })
  const role = new Role(org, "Employee")
  const manager = new Role(org, "Manager")
  const process = new Process(org, "search", {
    name: "Search",
    purpose: "Lookup contract",
  })
  const form = new Form(process, "Submit", {
    role,
    form: ES.Struct({
      choice: LookupField({ mode: "server", label: "Choice" }),
      group: Wrapper({
        details: Wrapper({
          restricted: LookupField({
            mode: "server",
            label: "Restricted",
            permission: { modify: manager },
            resolve: (value) =>
              Effect.succeed({ value, label: "Restricted label" }),
          }),
        }),
      }),
      dependent: LookupField({ mode: "local", maxItems: 500 }),
      dependentServer: LookupField({ mode: "server" }),
    }),
  })
  const items = [
    { value: "hidden-id", label: "Other" },
    { value: "inside", label: "Office café" },
    { value: "prefix-1", label: "Café desk", searchText: "Auckland furniture" },
    { value: "prefix-2", label: "Cafe chair" },
    { value: "exact", label: "CAFÉ" },
  ]
  let searches = 0
  form.lookups.choice.setQuery(({ filter }, limit) => {
    searches += 1
    return Effect.succeed(searchLookupItems(items, filter, limit))
  })
  let eligible = true
  form.lookups.choice.setResolver((value) =>
    Effect.succeed(
      eligible ? (items.find((item) => item.value === value) ?? null) : null,
    ),
  )
  form.lookups.dependent
    .dependsOn([form.lookups.choice])
    .setQuery(({ choice }, limit) =>
      Effect.succeed(
        Array.from({ length: Number(choice) }, (_, i) => ({
          value: `id-${i}`,
          label: `Child ${i}`,
        })).slice(0, limit),
      ),
    )
  const flow = process.start(form)
  form.lookups.dependentServer
    .dependsOn([form.lookups.choice])
    .setQuery(({ choice, filter }, limit) =>
      Effect.succeed(
        searchLookupItems(
          items.map((item) => ({ ...item, value: `${choice}-${item.value}` })),
          filter,
          limit,
        ),
      ),
    )
  const continuation = new Form(flow, "Choose", {
    role,
    form: () => ({
      choice: LookupField({
        label: "Choice",
        resolve: (value) => Effect.succeed({ value, label: "Todo label" }),
      }),
    }),
  })
  flow.next(continuation).end()
  const list = new List(org, "choices", {
    name: "Choices",
    roles: [role],
    output: { id: ES.String, choice: ES.String },
    query: () => Effect.succeed({ items: [], totalCount: 0 }),
    form: () => ({
      choice: LookupField({
        label: "Choice",
        resolve: (value) =>
          Effect.succeed(
            value === "list-id" ? { value, label: "List label" } : null,
          ),
      }),
    }),
    itemQuery: () => Effect.succeed(null),
    update: () => Effect.succeed(null),
  })
  const stepPath = normalizePath(form.node.path)
  const continuationPath = normalizePath(continuation.node.path)
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      makeLayers(
        org,
        {},
        {},
        {
          queryTodoById: (id) =>
            Effect.succeed({
              id,
              processExecutionId: "execution-1",
              processStateId: "state-1",
              startedByUserId: null,
              targetStepId: "choose",
              targetStepPath: id === "wrong-step" ? stepPath : continuationPath,
              processPath: "/search",
              orgUnitPath: "/",
              orgUnitId: "/",
              assignedToProviderUserId: id === "other-user" ? "other" : null,
              assignedToProviderUserEmail:
                id === "other-user" ? "other@example.com" : null,
              correctionRequiredAt: null,
              createdAtMs: 0,
              itemData: null,
              hasForEach: false,
              barrierScheduledFlowId: null,
            }),
          getProcessStateByTodoId: () =>
            Effect.succeed({
              processExecutionId: "execution-1",
              processStateId: "state-1",
              updatedAt: DateTime.makeUnsafe("2026-04-06T09:00:00Z"),
              processStartedAt: DateTime.makeUnsafe("2026-04-06T09:00:00Z"),
              state: {},
            }),
          getCompletedStepsForExecution: () => Effect.succeed([]),
        },
      ),
      Layer.succeed(CurrentPrincipal, null),
      LocalCedarAuthorizationLive.pipe(
        Layer.provide(
          Layer.succeed(LocalCedarConfig, {
            schemaText: readFileSync(getDefaultSchemaPath(), "utf8"),
            policiesText: [readFileSync(getDefaultPoliciesPath(), "utf8")],
          }),
        ),
      ),
      Layer.succeed(StepRoleQueries, {
        queryRolePathsByStepPath: (path) =>
          Effect.succeed({
            rolePath: "/Employee",
            supportingRolePaths: [],
            startsProcess: normalizePath(path) === stepPath,
            embedded: false,
          }),
        queryRolePathsByStepPaths: () => Effect.succeed(new Map()),
        queryRoleIdByPath: () => Effect.succeed(undefined),
      }),
    ),
  )
  try {
    const definition = await runtime.runPromise(systemSchema)
    const dynamic = await runtime.runPromise(dynamicSchema)
    const dependentQuery = form.lookupQueryName("dependent")
    const serverQuery = form.lookupQueryName("dependentServer")
    const schema = transformSchemaWithAuthDirective(
      createSchema({
        typeDefs: [
          ...["system", "rxdb"].map((name) =>
            readFileSync(
              new URL(
                `../../graphql-schema/graphql/${name}.graphql`,
                import.meta.url,
              ),
              "utf8",
            ),
          ),
          `input DependentInput { choice: String!, filter: String }
          extend type Query {
            ${dependentQuery}(input: DependentInput!, limit: Int): [LookupItem!]!
            ${serverQuery}(input: DependentInput!, limit: Int): [LookupItem!]!
          }`,
        ],
        resolvers: [
          definition.resolvers,
          {
            Query: {
              [dependentQuery]: dynamic.resolvers?.Query?.[dependentQuery],
              [serverQuery]: dynamic.resolvers?.Query?.[serverQuery],
            },
          },
        ],
      }),
      createResolverExecutor(runtime),
    )
    const execute = (
      filter: string,
      limit: number,
      context = makeContext(["/Employee"]),
    ) =>
      graphql({
        schema,
        source: `query($stepPath: String!, $filter: String!, $limit: Int!) { lookupSearch(stepPath: $stepPath, field: "choice", filter: $filter, limit: $limit) { items { value label } hasMore } }`,
        variableValues: { stepPath, filter, limit },
        contextValue: context,
      })
    const ranked = await execute("CaFe", 2)
    const searchDependent = (
      choice: string,
      context = makeContext(["/Employee"]),
    ) =>
      graphql({
        schema,
        source: `query($choice: String!) { ${serverQuery}(input: { choice: $choice, filter: "CAFE" }, limit: 3) { value label } }`,
        variableValues: { choice },
        contextValue: context,
      })
    for (const choice of ["north", "south"]) {
      const response = await searchDependent(choice)
      expect(response.errors).toBeUndefined()
      expect(response.data?.[serverQuery]).toEqual([
        { value: `${choice}-exact`, label: "CAFÉ" },
        { value: `${choice}-prefix-1`, label: "Café desk" },
        { value: `${choice}-prefix-2`, label: "Cafe chair" },
      ])
    }
    const executeDependent = (
      count: number,
      context = makeContext(["/Employee"]),
      limit = 501,
    ) =>
      graphql({
        schema,
        source: `query($choice: String!, $limit: Int!) { ${dependentQuery}(input: { choice: $choice, filter: "" }, limit: $limit) { value label } }`,
        variableValues: { choice: String(count), limit },
        contextValue: context,
      })
    for (const count of [150, 500, 501, 600]) {
      const response = await executeDependent(count)
      expect(response.errors).toBeUndefined()
      expect(response.data?.[dependentQuery]).toHaveLength(Math.min(count, 501))
    }
    expect(
      (await executeDependent(150, undefined, 20)).data?.[dependentQuery],
    ).toHaveLength(150)
    expect(
      (await executeDependent(600, undefined, 10000)).data?.[dependentQuery],
    ).toHaveLength(501)
    for (const context of [
      makeContext(["/Other"]),
      makeServiceAccountContext(),
    ]) {
      expect(
        (await searchDependent("south", context)).errors?.[0]?.extensions[
          "code"
        ],
      ).toBe("NotAuthorized")
      expect(
        (await executeDependent(150, context)).errors?.[0]?.extensions["code"],
      ).toBe("NotAuthorized")
    }
    expect(ranked.errors).toBeUndefined()
    expect(ranked.data?.["lookupSearch"]).toEqual({
      items: [items[4], { value: "prefix-1", label: "Café desk" }],
      hasMore: true,
    })
    expect((await execute("cafe", 4)).data?.["lookupSearch"]).toMatchObject({
      items: [
        { value: "exact" },
        { value: "prefix-1" },
        { value: "prefix-2" },
        { value: "inside" },
      ],
      hasMore: false,
    })
    expect((await execute("", 2)).data?.["lookupSearch"]).toEqual({
      items: items.slice(0, 2),
      hasMore: true,
    })
    expect((await execute("LAND af", 2)).data?.["lookupSearch"]).toEqual({
      items: [{ value: "prefix-1", label: "Café desk" }],
      hasMore: false,
    })
    expect((await execute("hidden-id", 2)).data?.["lookupSearch"]).toEqual({
      items: [],
      hasMore: false,
    })
    const resolve = (
      value: string,
      context = makeContext(["/Employee"]),
      field = "choice",
      path = stepPath,
      todoId?: string,
    ) =>
      graphql({
        schema,
        source: `query($stepPath: String!, $field: String!, $value: String!, $todoId: ID) { lookupSelection(stepPath: $stepPath, field: $field, value: $value, todoId: $todoId) { value label } }`,
        variableValues: { stepPath: path, field, value, todoId },
        contextValue: context,
      })
    const searchCount = searches
    // Not in the initial page, and searching its ID cannot find it.
    const restored = await resolve("prefix-2")
    expect(restored.errors).toBeUndefined()
    expect(restored.data?.["lookupSelection"]).toEqual({
      value: "prefix-2",
      label: "Cafe chair",
    })
    expect((await resolve("missing")).data?.["lookupSelection"]).toBeNull()
    eligible = false
    expect((await resolve("prefix-2")).data?.["lookupSelection"]).toBeNull()
    expect(
      (await resolve("prefix-2", makeContext(["/Employee"]), "missing")).data?.[
        "lookupSelection"
      ],
    ).toBeNull()
    for (const context of [
      makeContext([]),
      makeContext(["/Other"]),
      makeServiceAccountContext(),
    ]) {
      expect(
        (await resolve("prefix-2", context)).errors?.[0]?.extensions["code"],
      ).toBe("NotAuthorized")
    }
    expect(searches).toBe(searchCount)
    expect(
      (await resolve("id", makeContext(["/Employee"]), "restricted"))
        .errors?.[0]?.extensions["code"],
    ).toBe("NotAuthorized")
    expect(
      (
        await resolve(
          "id",
          makeContext(["/Employee", "/Manager"]),
          "restricted",
        )
      ).data?.["lookupSelection"],
    ).toEqual({ value: "id", label: "Restricted label" })
    expect(
      (
        await resolve(
          "list-id",
          makeContext(["/Employee"]),
          "choice",
          list.node.path,
        )
      ).data?.["lookupSelection"],
    ).toEqual({ value: "list-id", label: "List label" })
    expect(
      (
        await resolve(
          "list-id",
          makeContext(["/Other"]),
          "choice",
          list.node.path,
        )
      ).errors?.[0]?.extensions["code"],
    ).toBe("NotAuthorized")
    expect(
      (
        await resolve(
          "id",
          makeContext(["/Employee"]),
          "choice",
          continuationPath,
          "todo-1",
        )
      ).data?.["lookupSelection"],
    ).toEqual({ value: "id", label: "Todo label" })
    for (const todoId of [undefined, "wrong-step", "other-user"]) {
      expect(
        (
          await resolve(
            "id",
            makeContext(["/Employee"]),
            "choice",
            continuationPath,
            todoId,
          )
        ).errors?.[0]?.extensions["code"],
      ).toBe("NotAuthorized")
    }
    expect(
      (await execute("", 2, makeContext([]))).errors?.[0]?.extensions["code"],
    ).toBe("NotAuthorized")
    expect(
      (await execute("", 2, makeContext(["/Other"]))).errors?.[0]?.extensions[
        "code"
      ],
    ).toBe("NotAuthorized")
    expect(
      (await execute("", 2, makeServiceAccountContext())).errors?.[0]
        ?.extensions["code"],
    ).toBe("NotAuthorized")
  } finally {
    await runtime.dispose()
  }
})

const makeServiceAccountContext = (): UserContext => ({
  _requestTime: DateTime.makeUnsafe("2026-04-06T10:00:00.000Z"),
  _userDetails: {} as UserContext["_userDetails"],
  jwt: {
    mode: "access",
    type: "user",
    properties: {
      userId: "ci-client",
      clientId: "ci-client",
      roles: ["/CI"],
    },
    aud: "graphql-api",
    iss: "http://localhost:4020",
    sub: "ci-client",
    exp: 0,
    iat: 0,
  },
  userId: "ci-client",
})

type FormMetadataResult = {
  readonly stepPath: string
  readonly processName: string
  readonly stepName: string
  readonly publicFormTitle: string | null
  readonly publicFormDescription: string | null
  readonly processPath: string
  readonly mutationName: string
  readonly inputTypeName: string
  readonly completeMutationName: string
  readonly totalFields: number
  readonly requestData?: { readonly inaccessible: readonly string[] }
  readonly defaultValues: Record<string, unknown> | null
}

type ListFormMetadataResult = {
  readonly listPath: string
  readonly listName: string
  readonly updateMutationName: string | null
  readonly updateInputTypeName: string | null
  readonly deleteMutationName: string | null
  readonly requestData?: { readonly inaccessible: readonly string[] }
  readonly defaultValues: Record<string, unknown> | null
}

const makeAuthorizationService = (
  overrides: Partial<Context.Service.Shape<typeof AuthorizationService>> = {},
): Context.Service.Shape<typeof AuthorizationService> => ({
  canIssueDelegationSecret: () => Effect.succeed(false),
  canListDelegationTokens: () => Effect.succeed(false),
  canManageDelegation: () => Effect.succeed(false),
  canLogin: () => Effect.succeed(false),
  policyVersion: Effect.succeed("test-policy"),
  canCompleteStep: () => Effect.succeed(true),
  canViewEmbeddedForm: () => Effect.succeed(false),
  canCorrectPublicCompletionTodo: () => Effect.succeed(false),
  canRequestRole: () => Effect.succeed(false),
  canActOnBehalfOf: () => Effect.succeed(false),
  canViewExecution: () => Effect.succeed(false),
  canRestartExecution: () => Effect.succeed(false),
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
  ...overrides,
})

const makeLayers = (
  org: Organisation,
  authOverrides: Partial<
    Context.Service.Shape<typeof AuthorizationService>
  > = {},
  providerUserQueries: Partial<
    Context.Service.Shape<typeof ProviderUserQueries>
  > = {},
  stepCompletionOperations: Partial<
    Context.Service.Shape<typeof StepCompletionOperations>
  > = {},
) =>
  Layer.mergeAll(
    Layer.succeed(FileSystem.FileSystem, {
      exists: () => Effect.succeed(true),
      readFileString: () => Effect.succeed("type Query { _: Boolean }"),
    } as unknown as FileSystem.FileSystem),
    Layer.succeed(DynamicSchemaConfig, { schemaPath: "/tmp/org.graphql" }),
    Layer.succeed(
      OrgQueries,
      {} as unknown as Context.Service.Shape<typeof OrgQueries>,
    ),
    Layer.succeed(ProcessQueries, {
      queryAllProcesses: Effect.succeed([]),
    } as unknown as Context.Service.Shape<typeof ProcessQueries>),
    Layer.succeed(
      ProviderUserQueries,
      providerUserQueries as unknown as Context.Service.Shape<
        typeof ProviderUserQueries
      >,
    ),
    Layer.succeed(
      WorkflowQueries,
      {} as unknown as Context.Service.Shape<typeof WorkflowQueries>,
    ),
    Layer.succeed(
      StepCompletionOperations,
      stepCompletionOperations as unknown as Context.Service.Shape<
        typeof StepCompletionOperations
      >,
    ),
    Layer.succeed(
      AuthorizationService,
      makeAuthorizationService(authOverrides),
    ),
    Layer.succeed(StepRoleQueries, {
      queryRolePathsByStepPath: () =>
        Effect.succeed({
          rolePath: null,
          supportingRolePaths: [],
          startsProcess: true,
          embedded: false,
        }),
      queryRolePathsByStepPaths: () => Effect.succeed(new Map()),
      queryRoleIdByPath: (_rolePath: string) => Effect.succeed(undefined),
    }),
    Layer.succeed(OrganisationProvider, {
      organisation: org,
      orgPath: "/tmp/org",
      schemaPath: "/tmp/org.graphql",
    }),
  )

it("pages MCP starts only after removing entries without a callable start mutation", async () => {
  const org = new Organisation({ name: "Process catalog" })
  const role = new Role(org, "Employee")
  const models = [
    new Process(org, "multiple", { name: "Multiple", purpose: "Test" }),
    new Process(org, "scheduled", {
      name: "Scheduled",
      purpose: "Test",
      cron: {
        type: "weekly",
        weekday: "monday",
        timeZone: "UTC",
        at: { hour: 9, minute: 30 },
      },
    }),
    new Process(org, "single", { name: "Single", purpose: "Test" }),
  ]
  const rows = models.map((process, index): ProcessListRow => {
    const start =
      index === 1
        ? new NodeStep(process, "Start", {
            input: () => Effect.void,
            output: {},
            execute: () => Effect.succeed({}),
          })
        : new Form(process, "Start", { role, form: () => ({}) })
    process.start(start).end()
    if (index === 0)
      process
        .start(new Form(process, "Other", { role, form: () => ({}) }))
        .end()
    return {
      id: String(index),
      path: normalizePath(process.node.path),
      name: process.props.name,
      purpose: process.props.purpose,
      category: "Test",
      startStepPath: normalizePath(start.node.path),
      activeInstances: 0,
    }
  })
  const layers = Layer.merge(
    makeLayers(org),
    Layer.succeed(ProcessQueries, {
      queryAllProcesses: Effect.succeed([]),
      listProcesses: ({ offset, limit }) =>
        Effect.succeed(rows.slice(offset, offset + limit)),
    }),
  )
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const schema = yield* systemSchema
      const resolver = schema.resolvers?.Query?.["processes"] as (
        parent: unknown,
        args: { page: number; limit: number; requireStartMutation?: boolean },
        context: UserContext,
      ) => Effect.Effect<unknown>
      const context = makeContext(["/Employee"])
      return {
        sharedCatalog: yield* resolver(
          undefined,
          { page: 1, limit: 3 },
          context,
        ),
        mcpCatalog: yield* resolver(
          undefined,
          { page: 1, limit: 1, requireStartMutation: true },
          context,
        ),
      }
    }).pipe(Effect.provide(layers)),
  )
  expect(result.sharedCatalog).toMatchObject({ nodes: rows })
  expect(result.mcpCatalog).toMatchObject({
    nodes: [{ path: "/single" }],
    hasNextPage: false,
  })
})

const resolveFormMetadata = (
  org: Organisation,
  args: { stepPath: string; todoId?: string | null },
  context: UserContext,
  authOverrides: Partial<
    Context.Service.Shape<typeof AuthorizationService>
  > = {},
) =>
  Effect.gen(function* () {
    const schema = yield* systemSchema
    const resolver = (schema.resolvers?.Query?.["formMetadata"] ??
      (() => Effect.die("Missing formMetadata resolver"))) as (
      parent: unknown,
      args: { stepPath: string; todoId?: string | null },
      context: UserContext,
    ) => Effect.Effect<FormMetadataResult | null, unknown, never>

    return yield* resolver(undefined, args, context)
  }).pipe(Effect.provide(makeLayers(org, authOverrides)))

const resolveListFormMetadata = (
  org: Organisation,
  args: { listPath: string },
  context: UserContext,
  authOverrides: Partial<
    Context.Service.Shape<typeof AuthorizationService>
  > = {},
) =>
  Effect.gen(function* () {
    const schema = yield* systemSchema
    const resolver = (schema.resolvers?.Query?.["listFormMetadata"] ??
      (() => Effect.die("Missing listFormMetadata resolver"))) as (
      parent: unknown,
      args: { listPath: string },
      context: UserContext,
    ) => Effect.Effect<ListFormMetadataResult | null, unknown, never>

    return yield* resolver(undefined, args, context)
  }).pipe(Effect.provide(makeLayers(org, authOverrides)))

type LookupSuggestionResult = ReadonlyArray<{
  readonly value: string
  readonly label: string
}>

const resolveLookupSuggestions = (
  org: Organisation,
  args: {
    stepPath: string
    field: string
    filter?: string | null
    limit?: number | null
    todoId?: string | null
  },
  context: UserContext,
  authOverrides: Partial<Context.Service.Shape<typeof AuthorizationService>>,
  providerUserQueries: Partial<
    Context.Service.Shape<typeof ProviderUserQueries>
  >,
  stepCompletionOperations: Partial<
    Context.Service.Shape<typeof StepCompletionOperations>
  > = {},
) =>
  Effect.gen(function* () {
    const schema = yield* systemSchema
    const resolver = (schema.resolvers?.Query?.["lookupSuggestions"] ??
      (() => Effect.die("Missing lookupSuggestions resolver"))) as unknown as (
      parent: unknown,
      args: {
        stepPath: string
        field: string
        filter?: string | null
        limit?: number | null
        todoId?: string | null
      },
      context: UserContext,
    ) => Effect.Effect<LookupSuggestionResult, unknown, never>

    return yield* resolver(undefined, args, context)
  }).pipe(
    Effect.provide(
      makeLayers(
        org,
        authOverrides,
        providerUserQueries,
        stepCompletionOperations,
      ),
    ),
  )

const resolveListUpdate = (
  org: Organisation,
  args: {
    mutationName: string
    id: string
    input: Record<string, unknown>
  },
  context: UserContext,
  authOverrides: Partial<Context.Service.Shape<typeof AuthorizationService>>,
  providerUserQueries: Partial<
    Context.Service.Shape<typeof ProviderUserQueries>
  >,
) =>
  Effect.gen(function* () {
    const schema = yield* dynamicSchema
    const resolver = (schema.resolvers?.Mutation?.[args.mutationName] ??
      (() => Effect.die("Missing list update resolver"))) as unknown as (
      parent: unknown,
      args: { id: string; input: Record<string, unknown> },
      context: UserContext,
    ) => Effect.Effect<unknown, unknown, never>

    return yield* resolver(
      undefined,
      { id: args.id, input: args.input },
      context,
    )
  }).pipe(Effect.provide(makeLayers(org, authOverrides, providerUserQueries)))

const makeRestrictedFieldOrganisation = (executable = false) => {
  const org = new Organisation({ name: "Test Org" })
  const operations = new OrgUnit(org, "operations", {
    name: "Operations",
    type: "department",
  })
  const employee = new Role(operations, "employee", { name: "Employee" })
  const manager = new Role(operations, "manager", { name: "Manager" })
  const process = new Process(operations, "field-metadata", {
    name: "Field Metadata",
    purpose: "Test field permission metadata",
  })
  const submit = new Form(process, "Submit", {
    ...(executable && {
      browser: {
        entrypoint: "src/form.ts",
        exportName: "form",
        resolvePluginConfiguration: () =>
          Effect.succeed({
            title: { hint: "Visible hint" },
            requestedFor: { hint: "Restricted hint" },
          }),
      },
    }),
    role: employee,
    form: () => ({
      title: TextField({ default: "unchanged" }),
      notes: TextField(),
      requestedFor: ProviderUserField({
        default: CurrentProviderUser,
        permission: { modify: manager },
      }),
    }),
  })

  process.start(submit).end()

  return { org, employee, manager, stepPath: submit.node.path }
}

const makeRootScopedRestrictedFieldOrganisation = () => {
  const org = new Organisation({ name: "Test Org" })
  const employee = new Role(org, "employee", { name: "Employee" })
  const manager = new Role(org, "manager", { name: "Manager" })
  const process = new Process(org, "root-field-metadata", {
    name: "Root Field Metadata",
    purpose: "Test root-scoped field permission metadata",
  })
  const submit = new Form(process, "Submit", {
    role: employee,
    form: () => ({
      requestedFor: ProviderUserField({
        default: CurrentProviderUser,
        permission: { modify: manager },
      }),
    }),
  })

  process.start(submit).end()

  return { org, manager, stepPath: submit.node.path }
}

const makeCurrentProviderUserDefaultOrganisation = () => {
  const org = new Organisation({ name: "Test Org" })
  const operations = new OrgUnit(org, "operations", {
    name: "Operations",
    type: "department",
  })
  const employee = new Role(operations, "employee", { name: "Employee" })
  const process = new Process(operations, "provider-default", {
    name: "Provider Default",
    purpose: "Test provider user defaults",
  })
  const submit = new Form(process, "Submit", {
    role: employee,
    form: () => ({
      requestedFor: ProviderUserField({ default: CurrentProviderUser }),
    }),
  })

  process.start(submit).end()

  return { org, stepPath: submit.node.path }
}

const makePartialRestrictedFieldOrganisation = () => {
  const org = new Organisation({ name: "Test Org" })
  const operations = new OrgUnit(org, "operations", {
    name: "Operations",
    type: "department",
  })
  const employee = new Role(operations, "employee", { name: "Employee" })
  const manager = new Role(operations, "manager", { name: "Manager" })
  const process = new Process(operations, "partial-field-metadata", {
    name: "Partial Field Metadata",
    purpose: "Test partial field permission metadata",
  })
  const submit = new Form(process, "Submit", {
    role: employee,
    form: () => ({
      managerNote: TextField({
        default: "manager",
        permission: { modify: manager },
      }),
      employeeNote: TextField({
        default: "employee",
        permission: { modify: employee },
      }),
    }),
  })

  process.start(submit).end()

  return { org, manager, stepPath: submit.node.path }
}

const makeUnrestrictedFieldOrganisation = () => {
  const org = new Organisation({ name: "Test Org" })
  const operations = new OrgUnit(org, "operations", {
    name: "Operations",
    type: "department",
  })
  const employee = new Role(operations, "employee", { name: "Employee" })
  const process = new Process(operations, "unrestricted-field-metadata", {
    name: "Unrestricted Field Metadata",
    purpose: "Test unrestricted metadata counts",
  })
  const submit = new Form(process, "Submit", {
    role: employee,
    form: () => ({
      title: TextField(),
      notes: TextField(),
    }),
  })

  process.start(submit).end()

  return { org, employee, stepPath: submit.node.path }
}

const makeProviderUserLookupOrganisation = () => {
  const org = new Organisation({ name: "Test Org" })
  const operations = new OrgUnit(org, "operations", {
    name: "Operations",
    type: "department",
  })
  const employee = new Role(operations, "employee", { name: "Employee" })
  const process = new Process(operations, "provider-user-lookup", {
    name: "Provider User Lookup",
    purpose: "Test provider-user suggestions",
  })
  const submit = new Form(process, "Submit", {
    role: employee,
    form: () => ({
      requestedFor: ES.optional(ProviderUserField()),
    }),
  })

  process.start(submit).end()

  return { org, stepPath: submit.node.path }
}

const makeStateBackedLookupOrganisation = () => {
  const org = new Organisation({ name: "Test Org" })
  const operations = new OrgUnit(org, "operations", {
    name: "Operations",
    type: "department",
  })
  const employee = new Role(operations, "employee", { name: "Employee" })
  const process = new Process(operations, "state-lookup", {
    name: "State Lookup",
    purpose: "Test state-backed lookup suggestions",
  })
  const prepare = new NodeStep(process, "Prepare", {
    input: () => Effect.succeed({}),
    output: {
      choices: ES.Array(
        ES.Struct({
          value: ES.String,
          label: ES.String,
        }),
      ),
    },
    execute: () => Effect.succeed({ choices: [] }),
  })
  const flow = process.start(prepare)
  const choose = new Form(flow, "Choose", {
    role: employee,
    form: ({ query }) => ({
      selectedChoice: LookupField({
        label: "Choice",
        query: query(
          (state) => (filter, limit) =>
            Effect.succeed(
              state.choices
                .filter((choice) =>
                  choice.label.toLowerCase().includes(filter.toLowerCase()),
                )
                .slice(0, limit),
            ),
        ),
      }),
    }),
  })

  flow.next(choose).end()

  return { org, stepPath: choose.node.path }
}

const makeProviderUserLookupListOrganisation = (
  wrapped = false,
  restricted = false,
  includeManagerListRole = false,
) => {
  const org = new Organisation({ name: "Test Org" })
  const operations = new OrgUnit(org, "operations", {
    name: "Operations",
    type: "department",
  })
  const employee = new Role(operations, "employee", { name: "Employee" })
  const manager = new Role(operations, "manager", { name: "Manager" })
  const requestedFor = ProviderUserField(
    restricted ? { permission: { modify: manager } } : undefined,
  )
  const list = new List(operations, "employees", {
    name: "Employees",
    roles: includeManagerListRole ? [employee, manager] : [employee],
    output: {
      id: ES.String,
      requestedFor: ES.String,
    },
    query: () =>
      Effect.succeed({
        items: [],
        totalCount: 0,
      }),
    form: () =>
      wrapped
        ? {
            details: Wrapper({
              requestedFor,
            }),
          }
        : {
            requestedFor,
          },
    itemQuery: () => Effect.succeed(null),
    update: () => Effect.succeed(null),
  })

  return {
    org,
    listPath: list.node.path,
    mutationName: list.updateMutationName(),
    managerRolePath: normalizePath(manager.node.path),
  }
}

const makeProviderUserRow = (
  id: string,
  email: string,
  name: string,
): ProviderUserRow => ({
  id,
  userId: `user-${id}`,
  email,
  name,
  firstName: "",
  lastName: "",
  picture: "",
  locale: "",
  provider: "google",
  sub: id,
  orgUnitId: "operations",
  orgUnitPath: "/operations",
  createdAt: new Date("2026-04-06T10:00:00.000Z"),
  updatedAt: new Date("2026-04-06T10:00:00.000Z"),
  createdBy: null,
  updatedBy: null,
})

const lookupProviderUsers = [
  makeProviderUserRow("pu-current", "current@example.com", "Current User"),
  makeProviderUserRow("pu-manager", "manager@example.com", "Manager User"),
  makeProviderUserRow("pu-denied", "denied@example.com", "Denied User"),
  makeProviderUserRow("pu-roleless", "roleless@example.com", "Roleless User"),
]

const makeProviderUserLookupQueries = () => ({
  queryProviderUserByUserId: (userId: string) =>
    Effect.succeed(
      lookupProviderUsers.find((user) => user.userId === userId) ??
        lookupProviderUsers.find((user) => user.email === userId),
    ).pipe(
      Effect.map((providerUser) =>
        providerUser === undefined ? Option.none() : Option.some(providerUser),
      ),
    ),
  queryProviderUserByProviderUserId: (providerUserId: string) =>
    Effect.succeed(
      lookupProviderUsers.find((user) => user.id === providerUserId),
    ).pipe(
      Effect.map((providerUser) =>
        providerUser === undefined ? Option.none() : Option.some(providerUser),
      ),
    ),
  queryProviderUserByEmail: (email: string) =>
    Effect.succeed(
      lookupProviderUsers.find((user) => user.email === email),
    ).pipe(
      Effect.map((providerUser) =>
        providerUser === undefined ? Option.none() : Option.some(providerUser),
      ),
    ),
  queryProviderUsers: (
    filter: string,
    options: { offset: number; limit: number },
  ) =>
    Effect.succeed(
      lookupProviderUsers
        .filter((user) =>
          `${user.name} ${user.email}`
            .toLowerCase()
            .includes(filter.toLowerCase()),
        )
        .slice(options.offset, options.offset + options.limit),
    ),
  queryProviderUserRolePaths: (providerUserId: string) =>
    Effect.succeed(providerUserId === "pu-roleless" ? [] : ["/Employee"]),
  queryProviderUserRolePathsByProviderUserIds: (
    providerUserIds: readonly string[],
  ) =>
    Effect.succeed(
      new Map(
        providerUserIds.map((providerUserId) => [
          providerUserId,
          providerUserId === "pu-roleless" ? [] : ["/Employee"],
        ]),
      ),
    ),
})

const roleBasedFieldAuth: Context.Service.Shape<
  typeof AuthorizationService
>["canModifyField"] = (principal, resource) =>
  Effect.succeed(
    resource.role !== undefined &&
      principal.roles.some((role) => role.id === resource.role?.id),
  )

describe("systemSchema formMetadata", () => {
  it("returns zero-field metadata for authorized system-start steps", async () => {
    const org = new Organisation({ name: "Test Org" })
    const operations = new OrgUnit(org, "operations", {
      name: "Operations",
      type: "department",
    })
    const process = new Process(operations, "hello-system-start", {
      name: "Hello System Start",
      purpose: "Test system-start metadata",
    })
    const hello = new NodeStep(process, "Hello", {
      name: "Hello",
      input: () => Effect.succeed({}),
      output: { greeting: ES.String },
      execute: () => Effect.succeed({ greeting: "hello" }),
    })

    process.start(hello).end()

    const result = await Effect.runPromise(
      resolveFormMetadata(
        org,
        { stepPath: "/operations/hello-system-start/Hello" },
        makeContext(),
      ),
    )

    expect(result).toMatchObject({
      stepPath: "/operations/hello-system-start/Hello",
      processName: "Hello System Start",
      stepName: "Hello",
      processPath: "operations/hello-system-start",
      mutationName: "startOperationsHelloSystemStart",
      inputTypeName: "",
      completeMutationName: "",
      totalFields: 0,
      defaultValues: null,
    })
  })

  it("returns the configured form name as the step name", async () => {
    const org = new Organisation({ name: "Test Org" })
    const operations = new OrgUnit(org, "operations", {
      name: "Operations",
      type: "department",
    })
    const employee = new Role(operations, "employee", { name: "Employee" })
    const process = new Process(operations, "key-request", {
      name: "Key Request",
      purpose: "Test configured step names",
    })
    const order = new Form(process, "Order", {
      name: "Mint key",
      role: employee,
      form: () => ({ keyNumber: TextField({ label: "Key Number" }) }),
    })

    process.start(order).end()

    const result = await Effect.runPromise(
      resolveFormMetadata(
        org,
        { stepPath: "/operations/key-request/Order" },
        makeContext([employee.node.path]),
      ),
    )

    expect(result?.stepName).toBe("Mint key")
  })

  it("filters executable plugin configuration using field permissions", async () => {
    const { org, employee, manager, stepPath } =
      makeRestrictedFieldOrganisation(true)
    for (const [role, allowed] of [
      [employee, false],
      [manager, true],
    ] as const) {
      const result = await Effect.runPromise(
        resolveFormMetadata(org, { stepPath }, makeContext([role.node.path]), {
          canModifyField: roleBasedFieldAuth,
        }),
      )
      expect(result).toHaveProperty("pluginConfiguration", {
        title: { hint: "Visible hint" },
        ...(allowed && { requestedFor: { hint: "Restricted hint" } }),
      })
    }
  })

  it("omits restricted fields from metadata when modifyField is denied", async () => {
    const { org, employee, stepPath } = makeRestrictedFieldOrganisation()

    const result = await Effect.runPromise(
      resolveFormMetadata(
        org,
        { stepPath },
        makeContext([employee.node.path]),
        {
          canModifyField: roleBasedFieldAuth,
        },
      ),
    )
    if (!result) throw new Error("Expected form metadata")

    expect(result.defaultValues).toEqual({ title: "unchanged", notes: "" })
    expect(result.requestData?.inaccessible).toContain("requestedFor")
    expect(result?.totalFields).toBe(2)
  })

  it("keeps restricted fields in metadata when modifyField is allowed", async () => {
    const { org, manager, stepPath } = makeRestrictedFieldOrganisation()
    const seenOrgUnitIds: string[] = []

    const result = await Effect.runPromise(
      resolveFormMetadata(org, { stepPath }, makeContext([manager.node.path]), {
        canModifyField: (principal, resource) => {
          seenOrgUnitIds.push(resource.orgUnit.id)
          return roleBasedFieldAuth(principal, resource)
        },
      }),
    )

    expect(seenOrgUnitIds).toEqual(["operations"])
    if (result === null) throw new Error("Expected form metadata")

    expect(result.defaultValues).toMatchObject({
      title: "unchanged",
      notes: "",
      requestedFor: "current@example.com",
    })
    expect(result.requestData?.inaccessible).not.toContain("requestedFor")
    expect(result.totalFields).toBe(3)
  })

  it("keeps restricted fields for root-scoped processes", async () => {
    const { org, manager, stepPath } =
      makeRootScopedRestrictedFieldOrganisation()
    const seenOrgUnitIds: string[] = []

    const result = await Effect.runPromise(
      resolveFormMetadata(org, { stepPath }, makeContext([manager.node.path]), {
        canModifyField: (principal, resource) => {
          seenOrgUnitIds.push(resource.orgUnit.id)
          return roleBasedFieldAuth(principal, resource)
        },
      }),
    )

    // Root-scoped FormField resources use the empty string as their org-unit id.
    expect(seenOrgUnitIds).toEqual([""])
    expect(result?.defaultValues).toMatchObject({
      requestedFor: "current@example.com",
    })
    expect(result?.totalFields).toBe(1)
  })

  it("keeps unrestricted metadata field counts unchanged", async () => {
    const { org, employee, stepPath } = makeUnrestrictedFieldOrganisation()

    const result = await Effect.runPromise(
      resolveFormMetadata(org, { stepPath }, makeContext([employee.node.path])),
    )

    expect(result?.defaultValues).toEqual({ title: "", notes: "" })
    expect(result?.totalFields).toBe(2)
  })

  it("keeps only the restricted fields allowed by modifyField", async () => {
    const { org, manager, stepPath } = makePartialRestrictedFieldOrganisation()

    const result = await Effect.runPromise(
      resolveFormMetadata(org, { stepPath }, makeContext([manager.node.path]), {
        canModifyField: roleBasedFieldAuth,
      }),
    )

    expect(result?.defaultValues).toEqual({ managerNote: "manager" })
    expect(result?.totalFields).toBe(1)
  })

  it("does not resolve CurrentProviderUser defaults for service accounts", async () => {
    const { org, stepPath } = makeCurrentProviderUserDefaultOrganisation()

    const result = await Effect.runPromise(
      resolveFormMetadata(org, { stepPath }, makeServiceAccountContext()),
    )

    expect(result?.defaultValues).toMatchObject({
      requestedFor: "",
    })
  })

  it("hides restricted fields from service accounts even with matching policy", async () => {
    const { org, stepPath } = makeRestrictedFieldOrganisation()

    const result = await Effect.runPromise(
      resolveFormMetadata(org, { stepPath }, makeServiceAccountContext(), {
        canModifyField: () => Effect.succeed(true),
      }),
    )

    expect(result?.defaultValues).toEqual({ title: "unchanged", notes: "" })
  })
})

describe("systemSchema provider-user lookupSuggestions", () => {
  it("uses todo process state for state-backed lookup fields", async () => {
    const { org, stepPath } = makeStateBackedLookupOrganisation()

    const result = await Effect.runPromise(
      resolveLookupSuggestions(
        org,
        {
          stepPath,
          field: "selectedChoice",
          filter: "second",
          limit: 20,
          todoId: "todo-1",
        },
        makeContext(),
        {},
        {},
        {
          getProcessStateByTodoId: () =>
            Effect.succeed({
              processExecutionId: "execution-1",
              processStateId: "state-1",
              updatedAt: DateTime.makeUnsafe("2026-04-06T09:00:00.000Z"),
              processStartedAt: DateTime.makeUnsafe("2026-04-06T09:00:00.000Z"),
              state: {
                choices: [
                  { value: "first", label: "First choice" },
                  { value: "second", label: "Second choice" },
                ],
              },
            }),
          getCompletedStepsForExecution: () => Effect.succeed([]),
          queryTodoById: () =>
            Effect.succeed({
              id: "todo-1",
              processExecutionId: "execution-1",
              processStateId: "state-1",
              startedByUserId: null,
              targetStepId: "step-choose",
              targetStepPath: stepPath,
              processPath: "/operations/state-backed-lookup",
              orgUnitPath: "/operations",
              assignedToProviderUserId: null,
              assignedToProviderUserEmail: null,
              correctionRequiredAt: null,
              createdAtMs: 0,
              orgUnitId: "/operations",
              itemData: null,
              hasForEach: false,
              barrierScheduledFlowId: null,
            }),
        },
      ),
    )

    expect(result).toEqual([{ value: "second", label: "Second choice" }])
  })

  it("denies state-backed lookup when todo targets another step", async () => {
    const { org, stepPath } = makeStateBackedLookupOrganisation()

    await expect(
      Effect.runPromise(
        resolveLookupSuggestions(
          org,
          {
            stepPath,
            field: "selectedChoice",
            filter: "second",
            limit: 20,
            todoId: "todo-1",
          },
          makeContext(),
          {},
          {},
          {
            getProcessStateByTodoId: () =>
              Effect.succeed({
                processExecutionId: "execution-1",
                processStateId: "state-1",
                updatedAt: DateTime.makeUnsafe("2026-04-06T09:00:00.000Z"),
                processStartedAt: DateTime.makeUnsafe(
                  "2026-04-06T09:00:00.000Z",
                ),
                state: { choices: [] },
              }),
            getCompletedStepsForExecution: () => Effect.succeed([]),
            queryTodoById: () =>
              Effect.succeed({
                id: "todo-1",
                processExecutionId: "execution-1",
                processStateId: "state-1",
                startedByUserId: null,
                targetStepId: "step-other",
                targetStepPath: "/operations/other/step",
                processPath: "/operations/other",
                orgUnitPath: "/operations",
                assignedToProviderUserId: null,
                assignedToProviderUserEmail: null,
                correctionRequiredAt: null,
                createdAtMs: 0,
                orgUnitId: "/operations",
                itemData: null,
                hasForEach: false,
                barrierScheduledFlowId: null,
              }),
          },
        ),
      ),
    ).rejects.toThrow("Lookup todo todo-1 is not authorized")
  })

  it("fails state-backed lookup when todo process state is missing", async () => {
    const { org, stepPath } = makeStateBackedLookupOrganisation()

    await expect(
      Effect.runPromise(
        resolveLookupSuggestions(
          org,
          {
            stepPath,
            field: "selectedChoice",
            filter: "second",
            limit: 20,
            todoId: "todo-1",
          },
          makeContext(),
          {},
          {},
          {
            getProcessStateByTodoId: () => Effect.succeed(null),
          },
        ),
      ),
    ).rejects.toThrow('Process state not found for todo "todo-1"')
  })

  it("denies state-backed lookup when todo execution differs from state", async () => {
    const { org, stepPath } = makeStateBackedLookupOrganisation()

    await expect(
      Effect.runPromise(
        resolveLookupSuggestions(
          org,
          {
            stepPath,
            field: "selectedChoice",
            filter: "second",
            limit: 20,
            todoId: "todo-1",
          },
          makeContext(),
          {},
          {},
          {
            getProcessStateByTodoId: () =>
              Effect.succeed({
                processExecutionId: "execution-1",
                processStateId: "state-1",
                updatedAt: DateTime.makeUnsafe("2026-04-06T09:00:00.000Z"),
                processStartedAt: DateTime.makeUnsafe(
                  "2026-04-06T09:00:00.000Z",
                ),
                state: { choices: [] },
              }),
            getCompletedStepsForExecution: () => Effect.succeed([]),
            queryTodoById: () =>
              Effect.succeed({
                id: "todo-1",
                processExecutionId: "execution-2",
                processStateId: "state-1",
                startedByUserId: null,
                targetStepId: "step-choose",
                targetStepPath: stepPath,
                processPath: "/operations/state-backed-lookup",
                orgUnitPath: "/operations",
                assignedToProviderUserId: null,
                assignedToProviderUserEmail: null,
                correctionRequiredAt: null,
                createdAtMs: 0,
                orgUnitId: "/operations",
                itemData: null,
                hasForEach: false,
                barrierScheduledFlowId: null,
              }),
          },
        ),
      ),
    ).rejects.toThrow("Lookup todo todo-1 is not authorized")
  })

  it("denies lookup for provider-user fields hidden by field permissions", async () => {
    const { org, employee, stepPath } = makeRestrictedFieldOrganisation()

    await expect(
      Effect.runPromise(
        resolveLookupSuggestions(
          org,
          { stepPath, field: "requestedFor", filter: "current", limit: 20 },
          makeContext([employee.node.path]),
          {
            canModifyField: roleBasedFieldAuth,
            canActOnBehalfOf: () => Effect.succeed(true),
          },
          makeProviderUserLookupQueries(),
        ),
      ),
    ).rejects.toThrow("Lookup field requestedFor is not authorized")
  })

  it("includes the current provider user without requiring actOnBehalfOf", async () => {
    const { org, stepPath } = makeProviderUserLookupOrganisation()

    const result = await Effect.runPromise(
      resolveLookupSuggestions(
        org,
        { stepPath, field: "requestedFor", filter: "current", limit: 20 },
        makeContext(),
        { canActOnBehalfOf: () => Effect.succeed(false) },
        makeProviderUserLookupQueries(),
      ),
    )

    expect(result).toEqual([{ value: "pu-current", label: "Current User" }])
  })

  it("does not apply the self shortcut to service accounts", async () => {
    const { org, stepPath } = makeProviderUserLookupOrganisation()
    const serviceAccountContext = {
      ...makeServiceAccountContext(),
      userId: "pu-current",
    }

    const result = await Effect.runPromise(
      resolveLookupSuggestions(
        org,
        { stepPath, field: "requestedFor", filter: "current", limit: 20 },
        serviceAccountContext,
        { canActOnBehalfOf: () => Effect.succeed(false) },
        makeProviderUserLookupQueries(),
      ),
    )

    expect(result).toEqual([])
  })

  it("does not treat a non-matching session userId as the current provider user", async () => {
    const { org, stepPath } = makeProviderUserLookupOrganisation()
    const context = {
      ...makeContext(),
      userId: "pu-current",
    }

    const result = await Effect.runPromise(
      resolveLookupSuggestions(
        org,
        { stepPath, field: "requestedFor", filter: "current", limit: 20 },
        context,
        { canActOnBehalfOf: () => Effect.succeed(false) },
        makeProviderUserLookupQueries(),
      ),
    )

    expect(result).toEqual([])
  })

  it("returns non-self provider users allowed by actOnBehalfOf", async () => {
    const { org, stepPath } = makeProviderUserLookupOrganisation()

    const result = await Effect.runPromise(
      resolveLookupSuggestions(
        org,
        { stepPath, field: "requestedFor", filter: "manager", limit: 20 },
        makeContext(),
        { canActOnBehalfOf: () => Effect.succeed(true) },
        makeProviderUserLookupQueries(),
      ),
    )

    expect(result).toEqual([{ value: "pu-manager", label: "Manager User" }])
  })

  it("returns provider-user suggestions for list edit forms", async () => {
    const { org, listPath } = makeProviderUserLookupListOrganisation()

    const result = await Effect.runPromise(
      resolveLookupSuggestions(
        org,
        {
          stepPath: listPath,
          field: "requestedFor",
          filter: "manager",
          limit: 20,
        },
        makeContext(),
        {
          canCreateList: () => Effect.succeed(false),
          canUpdateList: () => Effect.succeed(true),
          canActOnBehalfOf: () => Effect.succeed(true),
        },
        makeProviderUserLookupQueries(),
      ),
    )

    expect(result).toEqual([{ value: "pu-manager", label: "Manager User" }])
  })

  it("returns provider-user suggestions for flattened list edit fields", async () => {
    const { org, listPath } = makeProviderUserLookupListOrganisation(true)

    const result = await Effect.runPromise(
      resolveLookupSuggestions(
        org,
        {
          stepPath: listPath,
          field: "requestedFor",
          filter: "manager",
          limit: 20,
        },
        makeContext(),
        {
          canCreateList: () => Effect.succeed(false),
          canUpdateList: () => Effect.succeed(true),
          canActOnBehalfOf: () => Effect.succeed(true),
        },
        makeProviderUserLookupQueries(),
      ),
    )

    expect(result).toEqual([{ value: "pu-manager", label: "Manager User" }])
  })

  it("denies restricted list edit lookups without field permission", async () => {
    const { org, listPath } = makeProviderUserLookupListOrganisation(
      false,
      true,
    )

    await expect(
      Effect.runPromise(
        resolveLookupSuggestions(
          org,
          { stepPath: listPath, field: "requestedFor", filter: "manager" },
          makeContext(),
          {
            canCreateList: () => Effect.succeed(false),
            canUpdateList: () => Effect.succeed(true),
            canModifyField: () => Effect.succeed(false),
            canActOnBehalfOf: () => Effect.succeed(true),
          },
          makeProviderUserLookupQueries(),
        ),
      ),
    ).rejects.toThrow("Lookup field requestedFor is not authorized")
  })

  it("allows restricted list edit lookups through any list role", async () => {
    const { org, listPath, managerRolePath } =
      makeProviderUserLookupListOrganisation(false, true, true)

    const result = await Effect.runPromise(
      resolveLookupSuggestions(
        org,
        { stepPath: listPath, field: "requestedFor", filter: "manager" },
        makeContext(),
        {
          canCreateList: () => Effect.succeed(false),
          canUpdateList: () => Effect.succeed(true),
          canModifyField: (_principal, resource) =>
            Effect.succeed(resource.stepRole?.id === managerRolePath),
          canActOnBehalfOf: () => Effect.succeed(true),
        },
        makeProviderUserLookupQueries(),
      ),
    )

    expect(result).toEqual([{ value: "pu-manager", label: "Manager User" }])
  })

  it("filters denied non-self provider users without returning hidden options", async () => {
    const { org, stepPath } = makeProviderUserLookupOrganisation()

    const result = await Effect.runPromise(
      resolveLookupSuggestions(
        org,
        { stepPath, field: "requestedFor", filter: "denied", limit: 20 },
        makeContext(),
        { canActOnBehalfOf: () => Effect.succeed(false) },
        makeProviderUserLookupQueries(),
      ),
    )

    expect(result).toEqual([])
  })

  it("excludes provider users with no roles", async () => {
    const { org, stepPath } = makeProviderUserLookupOrganisation()

    const result = await Effect.runPromise(
      resolveLookupSuggestions(
        org,
        { stepPath, field: "requestedFor", filter: "roleless", limit: 20 },
        makeContext(),
        { canActOnBehalfOf: () => Effect.succeed(true) },
        makeProviderUserLookupQueries(),
      ),
    )

    expect(result).toEqual([])
  })

  it("honors a zero lookup limit", async () => {
    const { org, stepPath } = makeProviderUserLookupOrganisation()

    const result = await Effect.runPromise(
      resolveLookupSuggestions(
        org,
        { stepPath, field: "requestedFor", filter: "current", limit: 0 },
        makeContext(),
        { canActOnBehalfOf: () => Effect.succeed(true) },
        makeProviderUserLookupQueries(),
      ),
    )

    expect(result).toEqual([])
  })

  it("returns authorized provider-user suggestions for empty filters", async () => {
    const { org, stepPath } = makeProviderUserLookupOrganisation()

    const result = await Effect.runPromise(
      resolveLookupSuggestions(
        org,
        { stepPath, field: "requestedFor", filter: "", limit: 20 },
        makeContext(),
        { canActOnBehalfOf: () => Effect.succeed(true) },
        makeProviderUserLookupQueries(),
      ),
    )

    expect(result).toEqual([
      { value: "pu-current", label: "Current User" },
      { value: "pu-manager", label: "Manager User" },
      { value: "pu-denied", label: "Denied User" },
    ])
  })

  it("filters denied non-self provider users from empty-filter suggestions", async () => {
    const { org, stepPath } = makeProviderUserLookupOrganisation()

    const result = await Effect.runPromise(
      resolveLookupSuggestions(
        org,
        { stepPath, field: "requestedFor", filter: "", limit: 20 },
        makeContext(),
        {
          canActOnBehalfOf: (_principal, providerUser) =>
            Effect.succeed(providerUser.uid.id !== "denied@example.com"),
        },
        makeProviderUserLookupQueries(),
      ),
    )

    expect(result).toEqual([
      { value: "pu-current", label: "Current User" },
      { value: "pu-manager", label: "Manager User" },
    ])
  })
})

describe("dynamicSchema list provider-user updates", () => {
  it("rejects denied provider-user targets submitted to list edit forms", async () => {
    const { org, mutationName } = makeProviderUserLookupListOrganisation()

    const error = await Effect.runPromise(
      resolveListUpdate(
        org,
        {
          mutationName,
          id: "employee-1",
          input: { requestedFor: "pu-denied" },
        },
        makeContext(),
        {
          canCreateList: () => Effect.succeed(false),
          canUpdateList: () => Effect.succeed(true),
          canActOnBehalfOf: () => Effect.succeed(false),
        },
        makeProviderUserLookupQueries(),
      ).pipe(Effect.flip) as Effect.Effect<NotAuthorized, never, never>,
    )

    expect(error).toBeInstanceOf(NotAuthorized)
    expect(error.action).toBe("actOnBehalfOf")
  })

  it("rejects denied flattened provider-user list edit fields", async () => {
    const { org, mutationName } = makeProviderUserLookupListOrganisation(true)

    const error = await Effect.runPromise(
      resolveListUpdate(
        org,
        {
          mutationName,
          id: "employee-1",
          input: { requestedFor: "pu-denied" },
        },
        makeContext(),
        {
          canCreateList: () => Effect.succeed(false),
          canUpdateList: () => Effect.succeed(true),
          canActOnBehalfOf: () => Effect.succeed(false),
        },
        makeProviderUserLookupQueries(),
      ).pipe(Effect.flip) as Effect.Effect<NotAuthorized, never, never>,
    )

    expect(error).toBeInstanceOf(NotAuthorized)
    expect(error.action).toBe("actOnBehalfOf")
  })

  it("rejects restricted list edit fields without field permission", async () => {
    const { org, mutationName } = makeProviderUserLookupListOrganisation(
      false,
      true,
    )

    const error = await Effect.runPromise(
      resolveListUpdate(
        org,
        {
          mutationName,
          id: "employee-1",
          input: { requestedFor: "pu-manager" },
        },
        makeContext(),
        {
          canCreateList: () => Effect.succeed(false),
          canUpdateList: () => Effect.succeed(true),
          canModifyField: () => Effect.succeed(false),
          canActOnBehalfOf: () => Effect.succeed(true),
        },
        makeProviderUserLookupQueries(),
      ).pipe(Effect.flip) as Effect.Effect<NotAuthorized, never, never>,
    )

    expect(error).toBeInstanceOf(NotAuthorized)
    expect(error.action).toBe("modifyField")
  })

  it("allows restricted list edit fields through any list role", async () => {
    const { org, mutationName, managerRolePath } =
      makeProviderUserLookupListOrganisation(false, true, true)

    await expect(
      Effect.runPromise(
        resolveListUpdate(
          org,
          {
            mutationName,
            id: "employee-1",
            input: { requestedFor: "pu-manager" },
          },
          makeContext(),
          {
            canCreateList: () => Effect.succeed(false),
            canUpdateList: () => Effect.succeed(true),
            canModifyField: (_principal, resource) =>
              Effect.succeed(resource.stepRole?.id === managerRolePath),
            canActOnBehalfOf: () => Effect.succeed(true),
          },
          makeProviderUserLookupQueries(),
        ),
      ),
    ).resolves.toBeNull()
  })
})

it("resolves create-only List lookups with create rather than update permission", async () => {
  const org = new Organisation({ name: "Test Org" })
  const role = new Role(org, "Employee")
  const reviewer = new Role(org, "Reviewer")
  const item = { value: "123", label: "Test student" }
  const list = new List(org, "attendance", {
    name: "Attendance",
    roles: [role, reviewer],
    output: { id: ES.String, notes: ES.String },
    query: () => Effect.succeed({ items: [], totalCount: 0 }),
    form: () => ({ notes: TextField({ label: "Notes" }) }),
    itemQuery: () => Effect.succeed(null),
    update: () => Effect.succeed(null),
    create: {
      form: () => ({
        studentNumber: LookupField({
          label: "Child",
          mode: "server",
          query: (filter) =>
            Effect.succeed(item.label.includes(filter) ? [item] : []),
          resolve: (value) =>
            Effect.succeed(value === item.value ? item : null),
        }),
        owner: ProviderUserField(),
      }),
      submit: () => Effect.succeed("created"),
    },
  })
  const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      makeLayers(org, {}, makeProviderUserLookupQueries()),
      Logger.layer([
        Logger.map(Logger.formatStructured, (entry) => {
          logs.push(entry)
        }),
      ]),
      LocalCedarAuthorizationLive.pipe(
        Layer.provide(
          Layer.succeed(LocalCedarConfig, {
            schemaText: readFileSync(getDefaultSchemaPath(), "utf8"),
            policiesText: [
              readFileSync(getDefaultPoliciesPath(), "utf8"),
              `permit(principal in PF::Role::"/Employee", action == PF::Action::"create", resource == PF::List::"/attendance");
               forbid(principal in PF::Role::"/Employee", action == PF::Action::"update", resource == PF::List::"/attendance");`,
            ],
          }),
        ),
      ),
    ),
  )
  try {
    const definition = await runtime.runPromise(systemSchema)
    const schema = transformSchemaWithAuthDirective(
      createSchema({
        typeDefs: ["system", "rxdb"].map((name) =>
          readFileSync(
            new URL(
              `../../graphql-schema/graphql/${name}.graphql`,
              import.meta.url,
            ),
            "utf8",
          ),
        ),
        resolvers: definition.resolvers,
      }),
      createResolverExecutor(runtime),
    )
    const execute = (
      fields: string,
      context = makeContext(["/Employee"]),
      listCreate: boolean | undefined = true,
    ) =>
      graphql({
        schema,
        source: `query($path: String!, $create: Boolean) { ${fields} }`,
        variableValues: {
          path: normalizePath(list.node.path),
          create: listCreate,
        },
        contextValue: context,
      })
    const suggestions = `lookupSuggestions(stepPath: $path, field: "studentNumber", filter: "student", listCreate: $create) { value label }`
    const result = await execute(suggestions)
    expect(result.errors).toBeUndefined()
    expect(result.data?.["lookupSuggestions"]).toEqual([item])
    const searchAndSelection = await execute(`
      lookupSearch(stepPath: $path, field: "studentNumber", filter: "student", listCreate: $create) { items { value label } hasMore }
      lookupSelection(stepPath: $path, field: "studentNumber", value: "123", listCreate: $create) { value label }
      owners: lookupSuggestions(stepPath: $path, field: "owner", filter: "Current", listCreate: $create) { label }
    `)
    expect(searchAndSelection.errors).toBeUndefined()
    expect(searchAndSelection.data).toEqual({
      lookupSearch: { items: [item], hasMore: false },
      lookupSelection: item,
      owners: [{ label: "Current User" }],
    })
    expect(
      (await execute(suggestions, makeContext(["/Employee"]), false))
        .errors?.[0]?.extensions,
    ).toMatchObject({ code: "NotAuthorized", action: "update" })
    expect(
      (await execute(suggestions, makeContext(["/Other"]))).errors?.[0]
        ?.extensions,
    ).toMatchObject({ code: "NotAuthorized", action: "query" })
    expect(
      (await execute(suggestions, makeContext(["/Reviewer"]))).errors?.[0]
        ?.extensions,
    ).toMatchObject({ code: "NotAuthorized", action: "create" })

    const missing = await execute(
      `lookupSuggestions(stepPath: $path, field: "missing", listCreate: $create) { value }`,
      {
        ...makeContext(["/Employee"]),
        _userDetails: { id: "usr-employee", by: "current@example.com" },
      },
    )
    expect(missing.errors?.[0]?.extensions).toEqual({
      code: "LookupFieldNotFoundError",
      fieldName: "missing",
      formStep: "/attendance",
    })
    const lookupFailure = logs.at(-1)
    expect(lookupFailure?.message).toContainEqual(
      expect.objectContaining({
        userId: "usr-employee",
        formPath: "/attendance",
        fieldName: "missing",
      }),
    )
    expect(JSON.stringify(lookupFailure)).not.toContain("current@example.com")
  } finally {
    await runtime.dispose()
  }
})

describe("systemSchema listCreateFormMetadata", () => {
  it.each([
    {
      session: "provider user",
      context: makeContext(),
      expectedOwner: "current@example.com",
    },
    {
      session: "service account",
      context: makeServiceAccountContext(),
      expectedOwner: "",
    },
  ])(
    "resolves current-user defaults for a $session",
    async ({ context, expectedOwner }) => {
      const org = new Organisation({ name: "Test Org" })
      const role = new Role(org, "Employee")
      const list = new List(org, "contacts", {
        name: "Contacts",
        roles: [role],
        output: { id: ES.String },
        query: () => Effect.succeed({ items: [], totalCount: 0 }),
        create: {
          form: () => ({
            owner: ProviderUserField({ default: CurrentProviderUser }),
          }),
          submit: () => Effect.succeed("created"),
        },
      })
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const schema = yield* systemSchema
          // The GraphQL resolver map erases the Effect context, as for the
          // other metadata resolver adapters in this test file.
          const resolver = schema.resolvers?.Query?.[
            "listCreateFormMetadata"
          ] as (
            parent: unknown,
            args: { listPath: string },
            context: UserContext,
          ) => Effect.Effect<unknown, unknown, never>
          return yield* resolver(
            undefined,
            { listPath: list.node.path },
            context,
          )
        }).pipe(
          Effect.provide(
            makeLayers(org, {
              canAccessList: () => Effect.succeed(true),
              canCreateList: () => Effect.succeed(true),
            }),
          ),
        ),
      )
      expect(result).toMatchObject({ defaultValues: { owner: expectedOwner } })
    },
  )
})

describe("systemSchema listFormMetadata", () => {
  it("returns authorized list mutation metadata", async () => {
    const org = new Organisation({ name: "Test Org" })
    const operations = new OrgUnit(org, "operations", {
      name: "Operations",
      type: "department",
    })
    const employee = new Role(operations, "employee", { name: "Employee" })
    const manager = new Role(operations, "manager", { name: "Manager" })
    const list = new List(operations, "employees", {
      name: "Employees",
      roles: [employee],
      output: {
        id: ES.String,
        name: ES.String,
        managerNote: ES.String,
      },
      query: () => Effect.succeed({ items: [], totalCount: 0 }),
      form: () => ({
        id: TextField({ label: "ID", readOnly: true }),
        name: TextField({ label: "Name" }),
        managerNote: TextField({
          label: "Manager note",
          default: "",
          permission: { modify: manager },
        }),
      }),
      itemQuery: () => Effect.succeed(null),
      update: () => Effect.succeed(null),
      delete: () => Effect.void,
    })

    const result = await Effect.runPromise(
      resolveListFormMetadata(
        org,
        { listPath: list.node.path },
        makeContext([employee.node.path]),
        {
          canAccessList: () => Effect.succeed(true),
          canCreateList: () => Effect.succeed(false),
          canUpdateList: () => Effect.succeed(true),
          canDeleteList: () => Effect.succeed(true),
        },
      ),
    )
    expect(result).toMatchObject({
      listPath: list.node.path,
      listName: "Employees",
      updateMutationName: list.updateMutationName(),
      updateInputTypeName: list.updateInputTypeName(),
      deleteMutationName: list.deleteMutationName(),
    })
  })

  it("keeps list forms without an update mutation read-only", async () => {
    const org = new Organisation({ name: "Test Org" })
    const employee = new Role(org, "employee", { name: "Employee" })
    const list = new List(org, "directory", {
      name: "Directory",
      roles: [employee],
      output: { id: ES.String, name: ES.String },
      query: () => Effect.succeed({ items: [], totalCount: 0 }),
      form: () => ({
        id: TextField({ label: "ID", readOnly: true }),
        name: TextField({ label: "Name", readOnly: true }),
      }),
      itemQuery: () => Effect.succeed(null),
    })

    const result = await Effect.runPromise(
      resolveListFormMetadata(
        org,
        { listPath: list.node.path },
        makeContext([employee.node.path]),
        {
          canAccessList: () => Effect.succeed(true),
          canCreateList: () => Effect.succeed(false),
          canUpdateList: () => Effect.succeed(false),
        },
      ),
    )
    expect(result).toMatchObject({
      updateMutationName: null,
      updateInputTypeName: null,
      deleteMutationName: null,
    })
  })

  it("does not expose a delete mutation for a non-deletable list", async () => {
    const org = new Organisation({ name: "Test Org" })
    const employee = new Role(org, "employee", { name: "Employee" })
    const list = new List(org, "employees", {
      name: "Employees",
      roles: [employee],
      output: { id: ES.String, name: ES.String },
      query: () => Effect.succeed({ items: [], totalCount: 0 }),
      form: () => ({ id: ES.String, name: TextField({ label: "Name" }) }),
      itemQuery: () => Effect.succeed(null),
      update: () => Effect.succeed(null),
    })

    const result = await Effect.runPromise(
      resolveListFormMetadata(
        org,
        { listPath: list.node.path },
        makeContext([employee.node.path]),
        {
          canAccessList: () => Effect.succeed(true),
          canCreateList: () => Effect.succeed(false),
          canUpdateList: () => Effect.succeed(true),
          canDeleteList: () => Effect.succeed(true),
        },
      ),
    )

    expect(result?.updateMutationName).toBe(list.updateMutationName())
    expect(result?.deleteMutationName).toBeNull()
  })

  it("keeps delete metadata behind delete authorization", async () => {
    const org = new Organisation({ name: "Test Org" })
    const employee = new Role(org, "employee", { name: "Employee" })
    const list = new List(org, "employees", {
      name: "Employees",
      roles: [employee],
      output: { id: ES.String, name: ES.String },
      query: () => Effect.succeed({ items: [], totalCount: 0 }),
      form: () => ({ id: ES.String, name: TextField({ label: "Name" }) }),
      itemQuery: () => Effect.succeed(null),
      update: () => Effect.succeed(null),
      delete: () => Effect.void,
    })

    const result = await Effect.runPromise(
      resolveListFormMetadata(
        org,
        { listPath: list.node.path },
        makeContext([employee.node.path]),
        {
          canAccessList: () => Effect.succeed(true),
          canCreateList: () => Effect.succeed(false),
          canUpdateList: () => Effect.succeed(true),
          canDeleteList: () => Effect.succeed(false),
        },
      ),
    )

    expect(result?.deleteMutationName).toBeNull()
  })
})

describe("availableLists process-start button", () => {
  it.each([
    { configured: true, canView: true, canStart: true, expected: "button" },
    { configured: true, canView: true, canStart: false, expected: "no button" },
    { configured: true, canView: false, canStart: true, expected: "no list" },
    { configured: false, canView: true, canStart: true, expected: "no button" },
  ])(
    "$expected when configured=$configured, view=$canView, start=$canStart",
    async ({ configured, canView, canStart, expected }) => {
      const org = new Organisation({ name: "Test" })
      const role = new Role(org, "viewer", { name: "Viewer" })
      const process = new Process(org, "sign-in", {
        name: "Sign-in",
        purpose: "Test",
      })
      const form = new Form(process, "Choose child", {
        name: "Choose child",
        role,
        form: () => ({ child: ES.String }),
      })
      process.start(form).end()
      new List(org, "attendance", {
        name: "Attendance",
        roles: [role],
        output: { child: ES.String },
        query: () => Effect.succeed({ items: [], totalCount: 0 }),
        ...(configured ? { startProcess: process } : {}),
      })
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const schema = yield* systemSchema
          // The resolver map erases its Effect context, as in the metadata adapters above.
          const resolver = schema.resolvers?.Query?.["availableLists"] as (
            parent: unknown,
            args: unknown,
            context: UserContext,
          ) => Effect.Effect<unknown, unknown, never>
          return yield* resolver(undefined, {}, makeContext())
        }).pipe(
          Effect.provide(
            makeLayers(org, {
              canAccessList: () => Effect.succeed(canView),
              canCompleteStep: (_principal, resource) => {
                expect(resource.startsProcess).toBe(true)
                expect(resource.uid.id).toBe("/sign-in/Choose child")
                return Effect.succeed(canStart)
              },
            }),
          ),
        ),
      )
      if (expected === "no list") expect(result).toEqual([])
      else
        expect(result).toMatchObject([
          {
            startProcess:
              expected === "button"
                ? {
                    name: "Sign-in",
                    startStepPath: "/sign-in/Choose child",
                  }
                : null,
          },
        ])
    },
  )
})
