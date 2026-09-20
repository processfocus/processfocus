import { DateTime, Effect, FiberRef, Layer, ManagedRuntime } from "effect"
import { buildSchema, parse, subscribe } from "graphql"
import {
  AuthorizationService,
  CurrentPrincipal,
  DelegationPrincipal,
  type ExecutionResource,
  ProviderUserPrincipal,
  ServiceAccountPrincipal,
  type StepResource,
  type TodoResource,
  type UserPrincipal,
} from "@pf/auth-policy"
import {
  ExecutionQueries,
  ScheduledFlowOperations,
  StepCompletionOperations,
  StepRoleQueries,
  TodoQueries,
  UserDetails,
} from "@pf/graphql-db-operations"
import type { NotAuthorized, Todo } from "@pf/graphql-schema"
import { RequestTime } from "@pf/request-time"
import { transformSchemaWithAuthDirective } from "../src/lib/auth-directive-plugin"
import {
  checkStepAuthorization,
  checkTodoAuthorization,
} from "../src/lib/authorization"
import { LocalDelegatedRealtime } from "../src/lib/delegated-realtime"
import type { DraftProcessExecutionEventDocument } from "../src/lib/draft-process-events"
import type { ExecutionEventDocument } from "../src/lib/execution-events"
import { createResolverExecutor } from "../src/lib/resolver-utils"
import {
  filterAuthorizedDrafts,
  filterAuthorizedExecutions,
  filterAuthorizedTodos,
} from "../src/lib/rxdb/subscription-filters"
import type { UserContext } from "../src/lib/types"
import { describe, expect, it } from "bun:test"

const fixedRequestTime = DateTime.unsafeMake(
  new Date("2026-03-27T00:00:00.000Z"),
)
const requestTimeTest = Layer.succeed(
  RequestTime,
  FiberRef.unsafeMake(fixedRequestTime),
)

const makeContext = (clientId: string, roles?: string[]): UserContext => ({
  _requestTime: fixedRequestTime,
  _userDetails: {} as UserContext["_userDetails"],
  jwt: {
    mode: "access",
    type: "user",
    properties: {
      // M2M tokens carry both userId and clientId; tests mirror that shape.
      userId: clientId,
      clientId,
      ...(roles ? { roles } : {}),
    },
    aud: "graphql-api",
    iss: "http://localhost:4020",
    sub: clientId,
    exp: 0,
    iat: 0,
  },
  userId: clientId,
})

const makeProviderContext = (props: {
  readonly providerUserId: string
  readonly email: string
  readonly roles: readonly string[]
}): UserContext => ({
  _requestTime: fixedRequestTime,
  _userDetails: {} as UserContext["_userDetails"],
  jwt: {
    mode: "access",
    type: "providerUser",
    properties: {
      userId: props.providerUserId,
      email: props.email,
      orgUnitId: "org-unit-id",
      orgUnitPath: "/",
      roles: [...props.roles],
    },
    aud: "graphql-api",
    iss: "http://localhost:4020",
    sub: props.providerUserId,
    exp: 0,
    iat: 0,
  },
  userId: props.providerUserId,
})

const makeAuthorizationService = (
  canComplete: (principal: UserPrincipal | ServiceAccountPrincipal) => boolean,
): AuthorizationService["Type"] => ({
  canIssueDelegationSecret: () => Effect.succeed(false),
  canListDelegationTokens: () => Effect.succeed(false),
  canManageDelegation: () => Effect.succeed(false),
  canLogin: () => Effect.succeed(false),
  canCompleteStep: (principal) => Effect.succeed(canComplete(principal)),
  canCompleteTodo: (principal) => Effect.succeed(canComplete(principal)),
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
})

const stepRoleLayer = Layer.succeed(StepRoleQueries, {
  queryRolePathsByStepPath: (_stepPath: string) =>
    Effect.succeed({
      rolePath: "/Employee",
      supportingRolePaths: [],
      startsProcess: true,
      embedded: false,
    }),
  queryRolePathsByStepPaths: (_stepPaths: string[]) =>
    Effect.succeed(
      new Map<
        string,
        {
          rolePath: string
          supportingRolePaths: readonly string[]
          startsProcess: boolean
          embedded: boolean
        }
      >(),
    ),
  queryRoleIdByPath: (_rolePath: string) => Effect.succeed(undefined),
})

const noAbandonableStepsLayer = Layer.mergeAll(
  Layer.succeed(StepCompletionOperations, {
    queryActiveTodoStepPaths: () => Effect.succeed([]),
    queryFailedTodosForExecution: () => Effect.succeed([]),
  } as unknown as StepCompletionOperations["Type"]),
  Layer.succeed(ScheduledFlowOperations, {
    queryPendingAbandonStepPaths: () => Effect.succeed([]),
  } as unknown as ScheduledFlowOperations["Type"]),
)

const failedSystemStartAbandonLayer = Layer.mergeAll(
  noAbandonableStepsLayer,
  Layer.succeed(ExecutionQueries, {
    getExecutions: () =>
      Effect.succeed([
        {
          id: "pex-weekly-access-review",
          startStepPath: "/weekly-access-review/Collect",
        },
      ]),
  } as unknown as ExecutionQueries["Type"]),
  Layer.succeed(StepRoleQueries, {
    queryRolePathsByStepPath: () =>
      Effect.succeed({
        rolePath: null,
        supportingRolePaths: [],
        startsProcess: true,
        embedded: false,
      }),
    queryRolePathsByStepPaths: (stepPaths: string[]) =>
      Effect.succeed(
        new Map(
          stepPaths.map((stepPath) => [
            stepPath,
            {
              rolePath: null,
              supportingRolePaths: [] as readonly string[],
              startsProcess: true,
              embedded: false,
            },
          ]),
        ),
      ),
    queryRoleIdByPath: (_rolePath: string) => Effect.succeed(undefined),
  }),
)

describe("checkStepAuthorization", () => {
  it("uses the service account principal for service-account start-step authorization", async () => {
    const seenPrincipalTypes: string[] = []
    const authLayer = Layer.succeed(
      AuthorizationService,
      makeAuthorizationService((principal) => {
        seenPrincipalTypes.push(principal.uid.type)
        return principal.uid.type === "PF::ServiceAccount"
      }),
    )

    await Effect.runPromise(
      checkStepAuthorization(
        makeContext("website"),
        "/enrolment-enquiry/Submit enquiry",
      ).pipe(
        Effect.provide(
          Layer.mergeAll(authLayer, stepRoleLayer, requestTimeTest),
        ),
      ),
    )

    expect(seenPrincipalTypes).toEqual(["PF::ServiceAccount"])
  })

  it("preserves role-scoped service-account roles on step authorization", async () => {
    const seenPrincipalTypes: string[] = []
    let seenRoleIds: string[] = []
    const authLayer = Layer.succeed(
      AuthorizationService,
      makeAuthorizationService((principal) => {
        seenPrincipalTypes.push(principal.uid.type)
        if (principal.uid.type === "PF::ServiceAccount") {
          seenRoleIds = principal.roles.map((role) => role.id)
          return true
        }
        return false
      }),
    )

    await Effect.runPromise(
      checkStepAuthorization(
        makeContext("ci-pipeline", ["/Employee"]),
        "/finance/purchase-request/Submit request",
      ).pipe(
        Effect.provide(
          Layer.mergeAll(authLayer, stepRoleLayer, requestTimeTest),
        ),
      ),
    )

    expect(seenPrincipalTypes).toEqual(["PF::ServiceAccount"])
    expect(seenRoleIds).toEqual(["/Employee"])
  })

  it("authorizes via supporting role when primary role is denied", async () => {
    const supportingStepRoleLayer = Layer.succeed(StepRoleQueries, {
      queryRolePathsByStepPath: (_stepPath: string) =>
        Effect.succeed({
          rolePath: "/Primary",
          supportingRolePaths: ["/Supporting"],
          startsProcess: false,
          embedded: false,
        }),
      queryRolePathsByStepPaths: (_stepPaths: string[]) =>
        Effect.succeed(new Map()),
      queryRoleIdByPath: (_rolePath: string) => Effect.succeed(undefined),
    })

    const trialRoles: string[] = []

    const authLayerWithTracking = Layer.succeed(AuthorizationService, {
      ...makeAuthorizationService(() => false),
      canCompleteStep: (
        _principal: UserPrincipal | ServiceAccountPrincipal,
        resource: StepResource,
      ) => {
        trialRoles.push(resource.role?.id ?? "")
        return Effect.succeed(resource.role?.id === "/Supporting")
      },
      canCompletePublicTodo: () => Effect.succeed(false),
    })

    const result = await Effect.runPromise(
      checkStepAuthorization(
        makeContext("website"),
        "/enrolment-enquiry/Submit enquiry",
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            authLayerWithTracking,
            supportingStepRoleLayer,
            requestTimeTest,
          ),
        ),
      ),
    )

    expect(result).toBe("/Supporting")
    // Primary should be tried first
    expect(trialRoles).toHaveLength(2)
    expect(trialRoles[0]).toBe("/Primary")
    expect(trialRoles[1]).toBe("/Supporting")
  })

  it("passes role-less start steps without a sentinel role", async () => {
    let seenResource: StepResource | undefined
    const authLayer = Layer.succeed(AuthorizationService, {
      ...makeAuthorizationService(() => true),
      canCompleteStep: (_principal, resource) => {
        seenResource = resource
        return Effect.succeed(true)
      },
      canCompletePublicTodo: () => Effect.succeed(false),
    })
    const noRoleStepLayer = Layer.succeed(StepRoleQueries, {
      queryRolePathsByStepPath: (_stepPath: string) =>
        Effect.succeed({
          rolePath: null,
          supportingRolePaths: [],
          startsProcess: true,
          embedded: false,
        }),
      queryRolePathsByStepPaths: (_stepPaths: string[]) =>
        Effect.succeed(new Map()),
      queryRoleIdByPath: (_rolePath: string) => Effect.succeed(undefined),
    })

    await Effect.runPromise(
      checkStepAuthorization(
        makeContext("website"),
        "/finance/system-process/Start",
      ).pipe(
        Effect.provide(
          Layer.mergeAll(authLayer, noRoleStepLayer, requestTimeTest),
        ),
      ),
    )

    expect(seenResource?.role).toBeUndefined()
  })

  it("returns NotAuthorized when user holds neither primary nor supporting role", async () => {
    const stepRoleLayer = Layer.succeed(StepRoleQueries, {
      queryRolePathsByStepPath: (_stepPath: string) =>
        Effect.succeed({
          rolePath: "/Primary",
          supportingRolePaths: ["/Supporting"],
          startsProcess: true,
          embedded: false,
        }),
      queryRolePathsByStepPaths: (_stepPaths: string[]) =>
        Effect.succeed(new Map()),
      queryRoleIdByPath: (_rolePath: string) => Effect.succeed(undefined),
    })

    const authLayer = Layer.succeed(AuthorizationService, {
      ...makeAuthorizationService(() => false),
      canCompleteStep: () => Effect.succeed(false),
      canCompletePublicTodo: () => Effect.succeed(false),
    })

    const exit = await Effect.runPromise(
      checkStepAuthorization(
        makeContext("user-with-no-role"),
        "/finance/purchase-request/Submit request",
      ).pipe(
        Effect.provide(
          Layer.mergeAll(authLayer, stepRoleLayer, requestTimeTest),
        ),
        Effect.exit,
      ),
    )

    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const error = exit.cause
      expect(error._tag).toBe("Fail")
      if ("error" in error) {
        expect(error.error._tag).toBe("NotAuthorized")
        expect((error.error as NotAuthorized).action).toBe("start")
      }
    }
  })
})

describe("checkTodoAuthorization", () => {
  it("uses email, not provider-user id, for direct-assigned todo authorization", async () => {
    let seenPrincipalId: string | undefined
    let seenAssignedTo: string | undefined
    const authLayer = Layer.succeed(AuthorizationService, {
      ...makeAuthorizationService(() => false),
      canCompleteTodo: (_principal, resource: TodoResource) => {
        seenPrincipalId = _principal.uid.id
        seenAssignedTo = resource.assignedTo?.id
        return Effect.succeed(
          _principal.uid.id === "recipient@example.com" &&
            resource.assignedTo?.id === "recipient@example.com",
        )
      },
    })

    const result = await Effect.runPromise(
      checkTodoAuthorization(
        makeProviderContext({
          providerUserId: "pu-recipient",
          email: "recipient@example.com",
          roles: ["/Employee"],
        }),
        {
          id: "todo-direct",
          stepPath: "/key-request/Pickup",
          processPath: "/key-request",
          processOrgUnitPath: "/",
          assignedToProviderUserEmail: "recipient@example.com",
        },
      ).pipe(
        Effect.provide(
          Layer.mergeAll(authLayer, stepRoleLayer, requestTimeTest),
        ),
      ),
    )

    expect(result).toBe("/Employee")
    expect(seenPrincipalId).toBe("recipient@example.com")
    expect(seenAssignedTo).toBe("recipient@example.com")
  })
})

describe("filterAuthorizedTodos", () => {
  it("uses the todo row process org-unit for subscription authorization", async () => {
    let seenOrgUnitId: string | undefined
    const authLayer = Layer.succeed(AuthorizationService, {
      ...makeAuthorizationService(() => false),
      canCompleteTodo: (_principal, resource: TodoResource) => {
        seenOrgUnitId = resource.orgUnit?.id
        return Effect.succeed(resource.orgUnit?.id === "/schools/north")
      },
    })

    const todoLayer = Layer.succeed(TodoQueries, {
      pullTodo: () => Effect.succeed([]),
      getTodoReplicationHead: () => Effect.succeed(null),
      listTodos: () => Effect.succeed([]),
      getTodos: () =>
        Effect.succeed([
          {
            id: "todo-subscription-org-unit",
            processExecutionId: "pex-subscription-org-unit",
            flowId: "flow-subscription-org-unit",
            processName: "Key Request",
            stepName: "Pickup",
            stepPath: "/key-request/Pickup",
            processPath: "/key-request",
            processOrgUnitPath: "/schools/north",
            rolePath: "/Employee",
            assignedToProviderUserId: null,
            assignedToProviderUserEmail: null,
            role: "Employee",
            description: "Pickup",
            status: "Active",
            priority: "Medium",
            assignedAt: "2026-03-27T00:00:00.000Z",
            dueAt: null,
            dueWarningAt: null,
            formComplexity: "simple",
            updatedAt: 1,
            deleted: false,
            summary: [],
          },
        ]),
    })

    const docs: Todo[] = [
      {
        id: "todo-subscription-org-unit",
        processExecutionId: "pex-subscription-org-unit",
        flowId: "flow-subscription-org-unit",
        processName: "Key Request",
        stepName: "Pickup",
        stepPath: "/key-request/Pickup",
        role: "Employee",
        description: "Pickup",
        status: "Active",
        priority: "Medium",
        assignedAt: "2026-03-27T00:00:00.000Z",
        dueAt: null,
        formComplexity: "simple",
        updatedAt: 1,
        deleted: false,
        summary: [],
      },
    ]

    const result = await Effect.runPromise(
      filterAuthorizedTodos(docs, {
        uid: { type: "PF::ProviderUser", id: "recipient@example.com" },
        roles: [{ type: "PF::Role", id: "/Employee" }],
        orgUnit: { type: "PF::OrgUnit", id: "/" },
      }).pipe(
        Effect.provide(
          Layer.mergeAll(authLayer, todoLayer, stepRoleLayer, requestTimeTest),
        ),
      ),
    )

    expect(result).toEqual(docs)
    expect(seenOrgUnitId).toBe("/schools/north")
  })

  it.each(["human", "delegated"])(
    "uses correction authorization for %s correction-required todo visibility",
    async (kind) => {
      let checkedNormalCompletion = false
      let checkedCorrection = false
      const authLayer = Layer.succeed(AuthorizationService, {
        ...makeAuthorizationService(() => false),
        canCompleteTodo: () => {
          checkedNormalCompletion = true
          return Effect.succeed(false)
        },
        canCorrectPublicCompletionTodo: (
          _principal,
          resource: TodoResource,
        ) => {
          checkedCorrection = true
          return Effect.succeed(resource.role?.id === "/Employee")
        },
      })

      const todoRow = {
        id: "todo-correction-visible",
        processExecutionId: "pex-correction-visible",
        flowId: "flow-correction-visible",
        processName: "Key Request",
        stepName: "Pickup",
        stepPath: "/key-request/Pickup",
        processPath: "/key-request",
        processOrgUnitPath: "/schools/north",
        rolePath: "/Employee",
        assignedToProviderUserId: null,
        assignedToProviderUserEmail: null,
        role: "Employee",
        description: "Pickup",
        status: "Correction Required" as const,
        priority: "Medium" as const,
        assignedAt: "2026-03-27T00:00:00.000Z",
        dueAt: null,
        dueWarningAt: null,
        formComplexity: "simple",
        updatedAt: 1,
        deleted: false,
        summary: [],
      }
      const todoLayer = Layer.succeed(TodoQueries, {
        pullTodo: () => Effect.succeed([]),
        getTodoReplicationHead: () => Effect.succeed(null),
        listTodos: () => Effect.succeed([]),
        getTodos: () => Effect.succeed([todoRow]),
      })

      const docs: Todo[] = [
        {
          id: todoRow.id,
          processExecutionId: todoRow.processExecutionId,
          flowId: todoRow.flowId,
          processName: todoRow.processName,
          stepName: todoRow.stepName,
          stepPath: todoRow.stepPath,
          role: todoRow.role,
          description: todoRow.description,
          status: todoRow.status,
          priority: todoRow.priority,
          assignedAt: todoRow.assignedAt,
          dueAt: todoRow.dueAt,
          formComplexity: todoRow.formComplexity,
          updatedAt: todoRow.updatedAt,
          deleted: todoRow.deleted,
          summary: todoRow.summary,
        },
      ]

      const result = await Effect.runPromise(
        filterAuthorizedTodos(
          docs,
          kind === "delegated"
            ? new DelegationPrincipal("delegate", {
                owner: "recipient@example.com",
                name: "Agent",
                roles: ["/Employee"],
                orgUnitId: "/",
              })
            : {
                uid: { type: "PF::ProviderUser", id: "recipient@example.com" },
                roles: [{ type: "PF::Role", id: "/Employee" }],
                orgUnit: { type: "PF::OrgUnit", id: "/" },
              },
        ).pipe(
          Effect.provide(
            Layer.mergeAll(
              authLayer,
              todoLayer,
              stepRoleLayer,
              requestTimeTest,
            ),
          ),
        ),
      )

      expect(result).toEqual(docs)
      expect(checkedCorrection).toBe(true)
      expect(checkedNormalCompletion).toBe(false)
    },
  )

  it("hides correction-required todos from service-account subscription filtering", async () => {
    let checkedNormalCompletion = false
    let checkedCorrection = false
    const authLayer = Layer.succeed(AuthorizationService, {
      ...makeAuthorizationService(() => false),
      canCompleteTodo: () => {
        checkedNormalCompletion = true
        return Effect.succeed(true)
      },
      canCorrectPublicCompletionTodo: () => {
        checkedCorrection = true
        return Effect.succeed(true)
      },
    })

    const todoRow = {
      id: "todo-correction-service-account-hidden",
      processExecutionId: "pex-correction-service-account-hidden",
      flowId: "flow-correction-service-account-hidden",
      processName: "Key Request",
      stepName: "Pickup",
      stepPath: "/key-request/Pickup",
      processPath: "/key-request",
      processOrgUnitPath: "/schools/north",
      rolePath: "/Employee",
      assignedToProviderUserId: null,
      assignedToProviderUserEmail: null,
      role: "Employee",
      description: "Pickup",
      status: "Correction Required" as const,
      priority: "Medium" as const,
      assignedAt: "2026-03-27T00:00:00.000Z",
      dueAt: null,
      dueWarningAt: null,
      formComplexity: "simple",
      updatedAt: 1,
      deleted: false,
      summary: [],
    }
    const todoLayer = Layer.succeed(TodoQueries, {
      pullTodo: () => Effect.succeed([]),
      getTodoReplicationHead: () => Effect.succeed(null),
      listTodos: () => Effect.succeed([]),
      getTodos: () => Effect.succeed([todoRow]),
    })

    const docs: Todo[] = [
      {
        id: todoRow.id,
        processExecutionId: todoRow.processExecutionId,
        flowId: todoRow.flowId,
        processName: todoRow.processName,
        stepName: todoRow.stepName,
        stepPath: todoRow.stepPath,
        role: todoRow.role,
        description: todoRow.description,
        status: todoRow.status,
        priority: todoRow.priority,
        assignedAt: todoRow.assignedAt,
        dueAt: todoRow.dueAt,
        formComplexity: todoRow.formComplexity,
        updatedAt: todoRow.updatedAt,
        deleted: todoRow.deleted,
        summary: todoRow.summary,
      },
    ]

    const result = await Effect.runPromise(
      filterAuthorizedTodos(
        docs,
        new ServiceAccountPrincipal("sync-service", ["/Employee"]),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(authLayer, todoLayer, stepRoleLayer, requestTimeTest),
        ),
      ),
    )

    expect(result).toEqual([])
    expect(checkedCorrection).toBe(false)
    expect(checkedNormalCompletion).toBe(false)
  })
})

describe("filterAuthorizedDrafts", () => {
  const draft = (
    id: string,
    owner: Pick<
      DraftProcessExecutionEventDocument,
      "startedByEmail" | "startedByUserId"
    >,
  ): DraftProcessExecutionEventDocument => ({
    id,
    processId: "prc-expenses",
    name: "Expenses",
    startStepPath: "/finance/expenses/Submit",
    state: {},
    fieldsCompleted: 0,
    totalFields: 1,
    lastSaved: "2026-03-27T00:00:00.000Z",
    updatedAt: 1,
    deleted: false,
    ...owner,
  })

  const authLayer = Layer.succeed(AuthorizationService, {
    ...makeAuthorizationService(() => false),
    canDraftStep: () => Effect.succeed(true),
  })

  it("allows only the service account's persisted user-owned drafts", async () => {
    const owned = draft("pst-owned", {
      startedByEmail: null,
      startedByUserId: "usr-service",
    })
    const other = draft("pst-other", {
      startedByEmail: null,
      startedByUserId: "usr-other",
    })

    const result = await Effect.runPromise(
      filterAuthorizedDrafts([owned, other], {
        uid: { type: "PF::ProviderUser", id: "usr-service" },
        roles: [{ type: "PF::Role", id: "/Employee" }],
        orgUnit: { type: "PF::OrgUnit", id: "/" },
      }).pipe(
        Effect.provide(
          Layer.mergeAll(authLayer, stepRoleLayer, requestTimeTest),
        ),
      ),
    )

    expect(result).toEqual([owned])
  })

  it("allows only the provider user's email-owned drafts", async () => {
    const owned = draft("pst-owned", {
      startedByEmail: "owner@example.com",
      startedByUserId: "usr-owner",
    })
    const other = draft("pst-other", {
      startedByEmail: "other@example.com",
      startedByUserId: "usr-other",
    })

    const result = await Effect.runPromise(
      filterAuthorizedDrafts([owned, other], {
        uid: { type: "PF::ProviderUser", id: "owner@example.com" },
        roles: [{ type: "PF::Role", id: "/Employee" }],
        orgUnit: { type: "PF::OrgUnit", id: "/" },
      }).pipe(
        Effect.provide(
          Layer.mergeAll(authLayer, stepRoleLayer, requestTimeTest),
        ),
      ),
    )

    expect(result).toEqual([owned])
  })

  it("uses the delegation owner for draft ownership but the delegate for Cedar, including supporting roles", async () => {
    const owned = draft("owned", {
      startedByEmail: "owner@example.com",
      startedByUserId: "usr-owner",
    })
    const other = draft("other", {
      startedByEmail: "other@example.com",
      startedByUserId: "usr-other",
    })
    const principal = new DelegationPrincipal("delegate", {
      owner: "owner@example.com",
      name: "Agent",
      roles: ["/Supporting"],
      orgUnitId: "/",
    })
    const roles = Layer.succeed(StepRoleQueries, {
      queryRolePathsByStepPath: () =>
        Effect.succeed({
          rolePath: "/Primary",
          supportingRolePaths: ["/Supporting"],
          startsProcess: true,
          embedded: true,
        }),
      queryRolePathsByStepPaths: (paths: string[]) =>
        Effect.succeed(
          new Map(
            paths.map((path) => [
              path,
              {
                rolePath: "/Primary",
                supportingRolePaths: ["/Supporting"],
                startsProcess: true,
                embedded: true,
              },
            ]),
          ),
        ),
      queryRoleIdByPath: () => Effect.succeed(undefined),
    })
    const checked: string[] = []
    const auth = Layer.succeed(AuthorizationService, {
      ...makeAuthorizationService(() => false),
      canDraftStep: (actor, resource) => {
        expect(actor).toBe(principal)
        expect(resource.embedded).toBe(true)
        checked.push(resource.role?.id ?? "none")
        return Effect.succeed(resource.role?.id === "/Supporting")
      },
    })
    expect(
      await Effect.runPromise(
        filterAuthorizedDrafts([owned, other], principal).pipe(
          Effect.provide(Layer.mergeAll(auth, roles, requestTimeTest)),
        ),
      ),
    ).toEqual([owned])
    expect(checked).toEqual(["/Primary", "/Supporting"])
  })
})

describe("root subscription authorization", () => {
  it("authorizes before acquiring the source and again on delivery with the delegation principal", async () => {
    let allowed = false
    let opened = 0
    const actors: string[] = []
    const runtime = ManagedRuntime.make(
      Layer.mergeAll(
        LocalDelegatedRealtime.layer,
        requestTimeTest,
        Layer.succeed(
          UserDetails,
          FiberRef.unsafeMake<UserContext["_userDetails"]>({
            id: "usr-owner",
            by: "owner@example.com",
          }),
        ),
        Layer.succeed(
          CurrentPrincipal,
          FiberRef.unsafeMake<UserPrincipal | null>(null),
        ),
        Layer.succeed(AuthorizationService, {
          ...makeAuthorizationService(() => false),
          canAccessField: (principal) => {
            actors.push(principal.uid.type)
            return Effect.succeed(allowed)
          },
        }),
      ),
    )
    const base = buildSchema(
      "type Query { hello: String } type Subscription { events: String }",
    )
    base.getSubscriptionType()!.getFields()["events"]!.subscribe = () => {
      opened++
      return {
        async *[Symbol.asyncIterator]() {
          yield { events: "secret" }
        },
      }
    }
    const schema = transformSchemaWithAuthDirective(
      base,
      createResolverExecutor(runtime),
    )
    const context = makeProviderContext({
      providerUserId: "usr-owner",
      email: "owner@example.com",
      roles: [],
    })
    context.jwt!.properties = {
      ...context.jwt!.properties,
      delegation: {
        id: "delegate",
        generationId: "generation",
        name: "Agent",
        expiresAt: Date.now() + 60_000,
      },
    }
    try {
      const denied = await subscribe({
        schema,
        document: parse("subscription { events }"),
        contextValue: context,
      })
      expect(Symbol.asyncIterator in denied).toBe(false)
      expect(opened).toBe(0)
      allowed = true
      const accepted = await subscribe({
        schema,
        document: parse("subscription { events }"),
        contextValue: context,
      })
      expect(opened).toBe(1)
      if (!(Symbol.asyncIterator in accepted))
        throw new Error("Expected subscription")
      allowed = false
      const iterator = accepted[Symbol.asyncIterator]()
      const delivery = await iterator.next()
      if (delivery.done) throw new Error("Expected authorization result")
      expect(delivery.value.data?.["events"]).toBeNull()
      expect(delivery.value.errors).toHaveLength(1)
      expect(actors).toEqual([
        "PF::Delegation",
        "PF::Delegation",
        "PF::Delegation",
      ])
      await iterator.return?.()
    } finally {
      await runtime.dispose()
    }
  })
})

describe("filterAuthorizedExecutions", () => {
  it.each([
    new ProviderUserPrincipal("recipient@example.com", {
      roles: ["/Office Staff"],
      orgUnitId: "/",
    }),
    new DelegationPrincipal("delegation", {
      owner: "recipient@example.com",
      name: "Reviewer",
      roles: ["/Office Staff"],
      orgUnitId: "/",
    }),
  ])(
    "preserves role and org-unit visibility for $uid.type",
    async (principal) => {
      let seenStartedByRoleId: string | undefined
      const authLayer = Layer.succeed(AuthorizationService, {
        ...makeAuthorizationService(() => false),
        canViewExecution: (actualPrincipal, resource: ExecutionResource) => {
          expect(actualPrincipal).toBe(principal)
          seenStartedByRoleId = resource.startedByRole?.id
          return Effect.succeed(
            resource.startedByRole?.id === "/Office Staff" &&
              resource.orgUnits.some((unit) => unit.id === "/Office/"),
          )
        },
      })

      const doc: ExecutionEventDocument = {
        id: "pex-office-staff",
        processStateId: "pst-office-staff",
        processName: "Career Guidance",
        processPath: "/career-guidance",
        status: "Completed",
        failureReason: null,
        abandonedReason: null,
        startedAt: "2026-03-27T00:00:00.000Z",
        finishedAt: null,
        completedSteps: 1,
        totalSteps: 2,
        durationMs: null,
        estimatedCompletionAt: null,
        slaWarningAt: null,
        slaTargetAt: null,
        updatedAt: 1,
        deleted: false,
        steps: [],
        startedByEmail: "office-staff@example.com",
        startedByRolePath: "/Office Staff",
        stepOrgUnitPaths: ["/Office/"],
      }
      const docs = [
        doc,
        { ...doc, id: "outside-org", stepOrgUnitPaths: ["/Other/"] },
      ]

      const result = await Effect.runPromise(
        filterAuthorizedExecutions(docs, principal).pipe(
          Effect.provide(
            Layer.mergeAll(
              authLayer,
              requestTimeTest,
              stepRoleLayer,
              noAbandonableStepsLayer,
            ),
          ),
        ),
      )

      expect(result).toEqual([
        { ...doc, canAbandonExecution: false, canRestartExecution: false },
      ])
      expect(seenStartedByRoleId).toBe("/Office Staff")
    },
  )

  it("attaches abandon capability for authorized running executions", async () => {
    const authLayer = Layer.succeed(AuthorizationService, {
      ...makeAuthorizationService(() => false),
      canViewExecution: () => Effect.succeed(true),
      canAbandonStep: (_principal, resource: StepResource) =>
        Effect.succeed(resource.uid.id === "/career-guidance/Waiting"),
    })
    const activeAbandonableStepLayer = Layer.mergeAll(
      Layer.succeed(StepCompletionOperations, {
        queryActiveTodoStepPaths: () =>
          Effect.succeed(["/career-guidance/Waiting"]),
      } as unknown as StepCompletionOperations["Type"]),
      Layer.succeed(ScheduledFlowOperations, {
        queryPendingAbandonStepPaths: () => Effect.succeed([]),
      } as unknown as ScheduledFlowOperations["Type"]),
    )

    const doc: ExecutionEventDocument = {
      id: "pex-career-guidance",
      processStateId: "pst-career-guidance",
      processName: "Career Guidance",
      processPath: "/career-guidance",
      status: "Running",
      failureReason: null,
      abandonedReason: null,
      startedAt: "2026-03-27T00:00:00.000Z",
      finishedAt: null,
      completedSteps: 1,
      totalSteps: 2,
      durationMs: null,
      estimatedCompletionAt: null,
      slaWarningAt: null,
      slaTargetAt: null,
      updatedAt: 1,
      deleted: false,
      steps: [],
      startedByEmail: "office-staff@example.com",
      startedByRolePath: "/Office Staff",
    }

    const result = await Effect.runPromise(
      filterAuthorizedExecutions([doc], {
        uid: { type: "PF::ProviderUser", id: "recipient@example.com" },
        roles: [{ type: "PF::Role", id: "/Office Staff" }],
        orgUnit: { type: "PF::OrgUnit", id: "/" },
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            authLayer,
            requestTimeTest,
            stepRoleLayer,
            activeAbandonableStepLayer,
          ),
        ),
      ),
    )

    expect(result).toEqual([
      { ...doc, canAbandonExecution: true, canRestartExecution: false },
    ])
  })

  it("uses supporting roles for abandon capability", async () => {
    const authLayer = Layer.succeed(AuthorizationService, {
      ...makeAuthorizationService(() => false),
      canViewExecution: () => Effect.succeed(true),
      canAbandonStep: (_principal, resource: StepResource) =>
        Effect.succeed(resource.role?.id === "/Supporting"),
    })
    const activeAbandonableStepLayer = Layer.mergeAll(
      Layer.succeed(StepCompletionOperations, {
        queryActiveTodoStepPaths: () =>
          Effect.succeed(["/career-guidance/Waiting"]),
      } as unknown as StepCompletionOperations["Type"]),
      Layer.succeed(ScheduledFlowOperations, {
        queryPendingAbandonStepPaths: () => Effect.succeed([]),
      } as unknown as ScheduledFlowOperations["Type"]),
      Layer.succeed(StepRoleQueries, {
        queryRolePathsByStepPath: (_stepPath: string) =>
          Effect.succeed({
            rolePath: "/Primary",
            supportingRolePaths: ["/Supporting"],
            startsProcess: false,
            embedded: false,
          }),
        queryRolePathsByStepPaths: (_stepPaths: string[]) =>
          Effect.succeed(
            new Map([
              [
                "/career-guidance/Waiting",
                {
                  rolePath: "/Primary",
                  supportingRolePaths: ["/Supporting"],
                  startsProcess: false,
                  embedded: false,
                },
              ],
            ]),
          ),
        queryRoleIdByPath: (_rolePath: string) => Effect.succeed(undefined),
      }),
    )

    const doc: ExecutionEventDocument = {
      id: "pex-career-guidance",
      processStateId: "pst-career-guidance",
      processName: "Career Guidance",
      processPath: "/career-guidance",
      status: "Running",
      failureReason: null,
      abandonedReason: null,
      startedAt: "2026-03-27T00:00:00.000Z",
      finishedAt: null,
      completedSteps: 1,
      totalSteps: 2,
      durationMs: null,
      estimatedCompletionAt: null,
      slaWarningAt: null,
      slaTargetAt: null,
      updatedAt: 1,
      deleted: false,
      steps: [],
      startedByEmail: "office-staff@example.com",
      startedByRolePath: "/Office Staff",
    }

    const result = await Effect.runPromise(
      filterAuthorizedExecutions([doc], {
        uid: { type: "PF::ProviderUser", id: "recipient@example.com" },
        roles: [{ type: "PF::Role", id: "/Supporting" }],
        orgUnit: { type: "PF::OrgUnit", id: "/" },
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            authLayer,
            requestTimeTest,
            activeAbandonableStepLayer,
          ),
        ),
      ),
    )

    expect(result).toEqual([
      { ...doc, canAbandonExecution: true, canRestartExecution: false },
    ])
  })

  it("attaches abandon capability for authorized Failed executions without live steps", async () => {
    const authLayer = Layer.succeed(AuthorizationService, {
      ...makeAuthorizationService(() => false),
      canViewExecution: () => Effect.succeed(true),
      canAbandonStep: (_principal, resource: StepResource) =>
        Effect.succeed(resource.uid.id === "/weekly-access-review/Collect"),
    })

    const doc: ExecutionEventDocument = {
      id: "pex-weekly-access-review",
      processStateId: "pst-weekly-access-review",
      processName: "Weekly Access Review",
      processPath: "/weekly-access-review",
      status: "Failed",
      failureReason: "blank email",
      abandonedReason: "blank email",
      startedAt: "2026-03-27T00:00:00.000Z",
      finishedAt: "2026-03-27T00:00:01.000Z",
      completedSteps: 0,
      totalSteps: 1,
      durationMs: 1000,
      estimatedCompletionAt: null,
      slaWarningAt: null,
      slaTargetAt: null,
      updatedAt: 1,
      deleted: false,
      steps: [],
      startedByEmail: null,
      startedByRolePath: null,
    }

    const result = await Effect.runPromise(
      filterAuthorizedExecutions([doc], {
        uid: { type: "PF::ProviderUser", id: "admin@example.com" },
        roles: [{ type: "PF::Role", id: "/Administrator" }],
        orgUnit: { type: "PF::OrgUnit", id: "/" },
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            authLayer,
            requestTimeTest,
            failedSystemStartAbandonLayer,
          ),
        ),
      ),
    )

    expect(result).toEqual([
      { ...doc, canAbandonExecution: true, canRestartExecution: false },
    ])
  })

  it("attaches abandon capability for authorized Running executions without live steps", async () => {
    const authLayer = Layer.succeed(AuthorizationService, {
      ...makeAuthorizationService(() => false),
      canViewExecution: () => Effect.succeed(true),
      canAbandonStep: (_principal, resource: StepResource) =>
        Effect.succeed(resource.uid.id === "/weekly-access-review/Collect"),
    })

    const doc: ExecutionEventDocument = {
      id: "pex-weekly-access-review",
      processStateId: "pst-weekly-access-review",
      processName: "Weekly Access Review",
      processPath: "/weekly-access-review",
      status: "Running",
      failureReason: null,
      abandonedReason: null,
      startedAt: "2026-03-27T00:00:00.000Z",
      finishedAt: null,
      completedSteps: 0,
      totalSteps: 1,
      durationMs: null,
      estimatedCompletionAt: null,
      slaWarningAt: null,
      slaTargetAt: null,
      updatedAt: 1,
      deleted: false,
      steps: [],
      startedByEmail: null,
      startedByRolePath: null,
    }

    const result = await Effect.runPromise(
      filterAuthorizedExecutions([doc], {
        uid: { type: "PF::ProviderUser", id: "admin@example.com" },
        roles: [{ type: "PF::Role", id: "/Administrator" }],
        orgUnit: { type: "PF::OrgUnit", id: "/" },
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            authLayer,
            requestTimeTest,
            failedSystemStartAbandonLayer,
          ),
        ),
      ),
    )

    expect(result).toEqual([
      { ...doc, canAbandonExecution: true, canRestartExecution: false },
    ])
  })

  it("attaches abandon capability for Docker-failed Running executions via the failed todo", async () => {
    const dockerStepPath = "/operations/deploy/Running deployment pipeline"
    const authLayer = Layer.succeed(AuthorizationService, {
      ...makeAuthorizationService(() => false),
      canViewExecution: () => Effect.succeed(true),
      canAbandonStep: (_principal, resource: StepResource) =>
        Effect.succeed(resource.uid.id === dockerStepPath),
    })
    const dockerFailedRunningAbandonLayer = Layer.mergeAll(
      Layer.succeed(StepCompletionOperations, {
        queryActiveTodoStepPaths: () => Effect.succeed([]),
        queryFailedTodosForExecution: () =>
          Effect.succeed([
            {
              todoId: "todo-docker",
              stepPath: dockerStepPath,
              isSystemStep: true,
            },
          ]),
      } as unknown as StepCompletionOperations["Type"]),
      Layer.succeed(ScheduledFlowOperations, {
        queryPendingAbandonStepPaths: () => Effect.succeed([]),
      } as unknown as ScheduledFlowOperations["Type"]),
      Layer.succeed(StepRoleQueries, {
        queryRolePathsByStepPath: () =>
          Effect.succeed({
            rolePath: null,
            supportingRolePaths: [],
            startsProcess: false,
            embedded: false,
          }),
        queryRolePathsByStepPaths: (stepPaths: string[]) =>
          Effect.succeed(
            new Map(
              stepPaths.map((stepPath) => [
                stepPath,
                {
                  rolePath: null,
                  supportingRolePaths: [] as readonly string[],
                  startsProcess: false,
                  embedded: false,
                },
              ]),
            ),
          ),
        queryRoleIdByPath: (_rolePath: string) => Effect.succeed(undefined),
      }),
    )

    const doc: ExecutionEventDocument = {
      id: "pex-deploy",
      processStateId: "pst-deploy",
      processName: "Deploy",
      processPath: "/operations/deploy",
      status: "Running",
      failureReason: "Step failed.",
      abandonedReason: null,
      startedAt: "2026-03-27T00:00:00.000Z",
      finishedAt: null,
      completedSteps: 1,
      totalSteps: 2,
      durationMs: null,
      estimatedCompletionAt: null,
      slaWarningAt: null,
      slaTargetAt: null,
      updatedAt: 1,
      deleted: false,
      steps: [],
      startedByEmail: "admin@example.com",
      startedByRolePath: "/Administrator",
    }

    const result = await Effect.runPromise(
      filterAuthorizedExecutions([doc], {
        uid: { type: "PF::ProviderUser", id: "admin@example.com" },
        roles: [{ type: "PF::Role", id: "/Administrator" }],
        orgUnit: { type: "PF::OrgUnit", id: "/" },
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            authLayer,
            requestTimeTest,
            dockerFailedRunningAbandonLayer,
          ),
        ),
      ),
    )

    expect(result).toEqual([
      { ...doc, canAbandonExecution: true, canRestartExecution: false },
    ])
  })

  it("omits abandon capability when Cedar denies the Failed start-step fallback", async () => {
    const authLayer = Layer.succeed(AuthorizationService, {
      ...makeAuthorizationService(() => false),
      canViewExecution: () => Effect.succeed(true),
      canAbandonStep: () => Effect.succeed(false),
    })

    const doc: ExecutionEventDocument = {
      id: "pex-weekly-access-review",
      processStateId: "pst-weekly-access-review",
      processName: "Weekly Access Review",
      processPath: "/weekly-access-review",
      status: "Failed",
      failureReason: "blank email",
      abandonedReason: "blank email",
      startedAt: "2026-03-27T00:00:00.000Z",
      finishedAt: "2026-03-27T00:00:01.000Z",
      completedSteps: 0,
      totalSteps: 1,
      durationMs: 1000,
      estimatedCompletionAt: null,
      slaWarningAt: null,
      slaTargetAt: null,
      updatedAt: 1,
      deleted: false,
      steps: [],
      startedByEmail: null,
      startedByRolePath: null,
    }

    const result = await Effect.runPromise(
      filterAuthorizedExecutions([doc], {
        uid: { type: "PF::ProviderUser", id: "employee@example.com" },
        roles: [{ type: "PF::Role", id: "/Employee" }],
        orgUnit: { type: "PF::OrgUnit", id: "/" },
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            authLayer,
            requestTimeTest,
            failedSystemStartAbandonLayer,
          ),
        ),
      ),
    )

    expect(result).toEqual([
      { ...doc, canAbandonExecution: false, canRestartExecution: false },
    ])
  })

  it("omits abandon capability for Abandoned executions", async () => {
    const authLayer = Layer.succeed(AuthorizationService, {
      ...makeAuthorizationService(() => false),
      canViewExecution: () => Effect.succeed(true),
      canAbandonStep: () => Effect.succeed(true),
    })

    const doc: ExecutionEventDocument = {
      id: "pex-abandoned",
      processStateId: "pst-abandoned",
      processName: "Career Guidance",
      processPath: "/career-guidance",
      status: "Abandoned",
      failureReason: null,
      abandonedReason: "manual cleanup",
      startedAt: "2026-03-27T00:00:00.000Z",
      finishedAt: "2026-03-27T00:00:01.000Z",
      completedSteps: 1,
      totalSteps: 2,
      durationMs: 1000,
      estimatedCompletionAt: null,
      slaWarningAt: null,
      slaTargetAt: null,
      updatedAt: 1,
      deleted: false,
      steps: [],
      startedByEmail: "office-staff@example.com",
      startedByRolePath: "/Office Staff",
    }

    const result = await Effect.runPromise(
      filterAuthorizedExecutions([doc], {
        uid: { type: "PF::ProviderUser", id: "admin@example.com" },
        roles: [{ type: "PF::Role", id: "/Administrator" }],
        orgUnit: { type: "PF::OrgUnit", id: "/" },
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            authLayer,
            requestTimeTest,
            stepRoleLayer,
            noAbandonableStepsLayer,
          ),
        ),
      ),
    )

    expect(result).toEqual([
      { ...doc, canAbandonExecution: false, canRestartExecution: false },
    ])
  })
})
