import { FileSystem } from "@effect/platform"
import { DateTime, Schema as ES, Effect, Layer, Option } from "effect"
import { AuthorizationService } from "@pf/auth-policy"
import {
  CurrentProviderUser,
  LookupField,
  ProviderUserField,
  TextField,
  Wrapper,
} from "@pf/form-schema"
import {
  OrgQueries,
  ProcessQueries,
  ProviderUserQueries,
  type ProviderUserRow,
  StepCompletionOperations,
  StepRoleQueries,
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
import { dynamicSchema } from "../src/lib/dynamic-resolvers"
import { DynamicSchemaConfig } from "../src/lib/graphql-api"
import { systemSchema } from "../src/lib/system-resolvers"
import type { UserContext } from "../src/lib/types"
import { describe, expect, it } from "bun:test"

const makeContext = (
  roles: readonly string[] = ["/Administrator"],
): UserContext => ({
  _requestTime: DateTime.unsafeMake("2026-04-06T10:00:00.000Z"),
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

const makeServiceAccountContext = (): UserContext => ({
  _requestTime: DateTime.unsafeMake("2026-04-06T10:00:00.000Z"),
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
  readonly formDefinition: {
    readonly components: Record<string, unknown>
    readonly rules: readonly unknown[]
  } | null
  readonly defaultValues: Record<string, unknown> | null
  readonly jsonSchema: Record<string, unknown> | null
}

type ListFormMetadataResult = {
  readonly listPath: string
  readonly listName: string
  readonly updateMutationName: string | null
  readonly updateInputTypeName: string | null
  readonly deleteMutationName: string | null
  readonly formDefinition: {
    readonly components: Record<string, unknown>
    readonly rules: readonly unknown[]
  } | null
  readonly defaultValues: Record<string, unknown> | null
  readonly jsonSchema: Record<string, unknown> | null
}

const makeAuthorizationService = (
  overrides: Partial<AuthorizationService["Type"]> = {},
): AuthorizationService["Type"] => ({
  canIssueDelegationSecret: () => Effect.succeed(false),
  canListDelegationTokens: () => Effect.succeed(false),
  canManageDelegation: () => Effect.succeed(false),
  canLogin: () => Effect.succeed(false),
  canCompleteStep: () => Effect.succeed(true),
  canCompleteTodo: () => Effect.succeed(true),
  canCorrectPublicCompletionTodo: () => Effect.succeed(false),
  canCompletePublicTodo: () => Effect.succeed(false),
  canRequestRole: () => Effect.succeed(false),
  canRequestProviderUserPermissions: () => Effect.succeed(false),
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
  authOverrides: Partial<AuthorizationService["Type"]> = {},
  providerUserQueries: Partial<ProviderUserQueries["Type"]> = {},
  stepCompletionOperations: Partial<StepCompletionOperations["Type"]> = {},
) =>
  Layer.mergeAll(
    Layer.succeed(FileSystem.FileSystem, {
      exists: () => Effect.succeed(true),
      readFileString: () => Effect.succeed("type Query { _: Boolean }"),
    } as unknown as FileSystem.FileSystem),
    Layer.succeed(DynamicSchemaConfig, { schemaPath: "/tmp/org.graphql" }),
    Layer.succeed(OrgQueries, {} as unknown as OrgQueries["Type"]),
    Layer.succeed(ProcessQueries, {
      queryAllProcesses: Effect.succeed([]),
    } as unknown as ProcessQueries["Type"]),
    Layer.succeed(
      ProviderUserQueries,
      providerUserQueries as unknown as ProviderUserQueries["Type"],
    ),
    Layer.succeed(WorkflowQueries, {} as unknown as WorkflowQueries["Type"]),
    Layer.succeed(
      StepCompletionOperations,
      stepCompletionOperations as unknown as StepCompletionOperations["Type"],
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

const resolveFormMetadata = (
  org: Organisation,
  args: { stepPath: string; todoId?: string | null },
  context: UserContext,
  authOverrides: Partial<AuthorizationService["Type"]> = {},
) =>
  Effect.gen(function* () {
    const schema = yield* systemSchema
    const resolver = (schema.resolvers?.Query?.["formMetadata"] ??
      (() => Effect.dieMessage("Missing formMetadata resolver"))) as (
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
  authOverrides: Partial<AuthorizationService["Type"]> = {},
) =>
  Effect.gen(function* () {
    const schema = yield* systemSchema
    const resolver = (schema.resolvers?.Query?.["listFormMetadata"] ??
      (() => Effect.dieMessage("Missing listFormMetadata resolver"))) as (
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
  authOverrides: Partial<AuthorizationService["Type"]>,
  providerUserQueries: Partial<ProviderUserQueries["Type"]>,
  stepCompletionOperations: Partial<StepCompletionOperations["Type"]> = {},
) =>
  Effect.gen(function* () {
    const schema = yield* systemSchema
    const resolver = (schema.resolvers?.Query?.["lookupSuggestions"] ??
      (() =>
        Effect.dieMessage(
          "Missing lookupSuggestions resolver",
        ))) as unknown as (
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
  authOverrides: Partial<AuthorizationService["Type"]>,
  providerUserQueries: Partial<ProviderUserQueries["Type"]>,
) =>
  Effect.gen(function* () {
    const schema = yield* dynamicSchema
    const resolver = (schema.resolvers?.Mutation?.[args.mutationName] ??
      (() => Effect.dieMessage("Missing list update resolver"))) as unknown as (
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

const makeRestrictedFieldOrganisation = () => {
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

const roleBasedFieldAuth: AuthorizationService["Type"]["canModifyField"] = (
  principal,
  resource,
) =>
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

    expect(
      Object.values(result?.formDefinition?.components ?? {}).every(
        (component) =>
          typeof component === "object" &&
          component !== null &&
          "_tag" in component,
      ),
    ).toBe(true)
    expect(result).toMatchObject({
      stepPath: "/operations/hello-system-start/Hello",
      processName: "Hello System Start",
      stepName: "Hello",
      processPath: "operations/hello-system-start",
      mutationName: "startOperationsHelloSystemStart",
      inputTypeName: "",
      completeMutationName: "",
      totalFields: 0,
      formDefinition: null,
      defaultValues: null,
      jsonSchema: null,
    })
  })

  it("returns an empty canonical rule channel for forms without rules", async () => {
    const org = new Organisation({ name: "Test Org" })
    const operations = new OrgUnit(org, "operations", {
      name: "Operations",
      type: "department",
    })
    const employee = new Role(operations, "employee", { name: "Employee" })
    const process = new Process(operations, "key-request", {
      name: "Key Request",
      purpose: "Test absent form rules metadata",
    })
    const order = new Form(process, "Order", {
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

    expect(result?.formDefinition).toEqual({
      components: expect.objectContaining({
        keyNumber: expect.objectContaining({ _tag: "text" }),
      }),
      rules: [],
    })
  })

  it("returns serialized rules for forms with rules", async () => {
    const org = new Organisation({ name: "Test Org" })
    const operations = new OrgUnit(org, "operations", {
      name: "Operations",
      type: "department",
    })
    const employee = new Role(operations, "employee", { name: "Employee" })
    const process = new Process(operations, "key-request", {
      name: "Key Request",
      purpose: "Test form rules metadata",
    })
    const order = new Form(process, "Order", {
      role: employee,
      form: () => ({
        keyNumber: TextField({ label: "Key Number" }),
        details: TextField({ label: "Details" }),
      }),
    }).rules((value, rule) => [
      rule.when(value.keyNumber.equals("restricted")).effects({
        details: { hidden: true },
      }),
    ])

    process.start(order).end()

    const result = await Effect.runPromise(
      resolveFormMetadata(
        org,
        { stepPath: "/operations/key-request/Order" },
        makeContext([employee.node.path]),
      ),
    )

    expect(result?.formDefinition?.rules).toEqual([
      {
        condition: {
          _tag: "equals",
          left: { _tag: "field", path: ["keyNumber"] },
          right: { _tag: "literal", value: "restricted" },
        },
        effects: [{ target: ["details"], state: { hidden: true } }],
      },
    ])
    expect(
      Object.values(result?.formDefinition?.components ?? {}).every(
        (component) =>
          typeof component === "object" &&
          component !== null &&
          "_tag" in component,
      ),
    ).toBe(true)
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

    expect(result.formDefinition?.components).toHaveProperty("title")
    expect(result.formDefinition?.components).toHaveProperty("notes")
    expect(result.formDefinition?.components).not.toHaveProperty("requestedFor")
    expect(result.defaultValues).toEqual({ title: "unchanged", notes: "" })
    expect(
      (result.jsonSchema as { properties?: Record<string, unknown> })
        .properties,
    ).not.toHaveProperty("requestedFor")
    expect(
      (result.jsonSchema as { required?: string[] }).required ?? [],
    ).not.toContain("requestedFor")
    expect(result?.totalFields).toBe(2)
  })

  it("omits rules that reference restricted fields when modifyField is denied", async () => {
    const org = new Organisation({ name: "Test Org" })
    const operations = new OrgUnit(org, "operations", {
      name: "Operations",
      type: "department",
    })
    const employee = new Role(operations, "employee", { name: "Employee" })
    const manager = new Role(operations, "manager", { name: "Manager" })
    const process = new Process(operations, "field-rule-metadata", {
      name: "Field Rule Metadata",
      purpose: "Test field permission rule metadata",
    })
    const submit = new Form(process, "Submit", {
      role: employee,
      form: () => ({
        title: TextField(),
        notes: TextField(),
        requestedFor: ProviderUserField({
          default: CurrentProviderUser,
          permission: { modify: manager },
        }),
      }),
    }).rules((value, rule) => [
      rule.when(value.title.blank()).effects({
        notes: { disabled: true },
      }),
      rule.when(value.requestedFor.present()).effects({
        notes: { hidden: true },
      }),
      rule.when(value.title.present()).effects({
        requestedFor: { hidden: true },
      }),
      rule
        .when(value.notes.present())
        .effects(
          { title: { disabled: true } },
          { requestedFor: { hidden: true } },
        ),
    ])

    process.start(submit).end()

    const result = await Effect.runPromise(
      resolveFormMetadata(
        org,
        { stepPath: submit.node.path },
        makeContext([employee.node.path]),
        { canModifyField: roleBasedFieldAuth },
      ),
    )
    if (!result) throw new Error("Expected form metadata")

    expect(result.formDefinition?.rules).toEqual([
      {
        condition: {
          _tag: "blank",
          value: { _tag: "field", path: ["title"] },
        },
        effects: [{ target: ["notes"], state: { disabled: true } }],
      },
    ])
    expect(result.formDefinition?.components).not.toHaveProperty("requestedFor")

    const managerResult = await Effect.runPromise(
      resolveFormMetadata(
        org,
        { stepPath: submit.node.path },
        makeContext([manager.node.path]),
        { canModifyField: roleBasedFieldAuth },
      ),
    )
    expect(managerResult?.formDefinition?.components).toHaveProperty(
      "requestedFor",
    )
    expect(managerResult?.formDefinition?.rules).toHaveLength(4)
    expect(JSON.stringify(managerResult?.formDefinition?.rules)).toContain(
      "requestedFor",
    )
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

    expect(result.formDefinition?.components).toHaveProperty("title")
    expect(result.formDefinition?.components).toHaveProperty("notes")
    expect(result.formDefinition?.components).toHaveProperty("requestedFor")
    expect(result.defaultValues).toMatchObject({
      title: "unchanged",
      notes: "",
      requestedFor: "current@example.com",
    })
    expect(
      (result.jsonSchema as { properties?: Record<string, unknown> })
        .properties,
    ).toHaveProperty("requestedFor")
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
    expect(result?.formDefinition?.components).toHaveProperty("requestedFor")
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

    expect(result?.formDefinition?.components).toHaveProperty("title")
    expect(result?.formDefinition?.components).toHaveProperty("notes")
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

    expect(result?.formDefinition?.components).toHaveProperty("managerNote")
    expect(result?.formDefinition?.components).not.toHaveProperty(
      "employeeNote",
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

    expect(result?.formDefinition?.components).not.toHaveProperty(
      "requestedFor",
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
              updatedAt: DateTime.unsafeMake("2026-04-06T09:00:00.000Z"),
              processStartedAt: DateTime.unsafeMake("2026-04-06T09:00:00.000Z"),
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
                updatedAt: DateTime.unsafeMake("2026-04-06T09:00:00.000Z"),
                processStartedAt: DateTime.unsafeMake(
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
                updatedAt: DateTime.unsafeMake("2026-04-06T09:00:00.000Z"),
                processStartedAt: DateTime.unsafeMake(
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
  it("returns the structured definition additively with list field metadata", async () => {
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
      formDefinition: {
        components: {
          id: expect.objectContaining({ readonly: true }),
          name: expect.objectContaining({ _tag: "text", field: "name" }),
          managerNote: expect.objectContaining({
            permission: { modify: normalizePath(manager.node.path) },
          }),
        },
        rules: [],
      },
    })
    expect(result?.jsonSchema?.["properties"]).not.toHaveProperty("id")
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
      formDefinition: {
        components: {
          id: expect.objectContaining({ readonly: true }),
          name: expect.objectContaining({ readonly: true }),
        },
        rules: [],
      },
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
