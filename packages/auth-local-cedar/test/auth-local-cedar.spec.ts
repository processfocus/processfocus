import { FileSystem } from "@effect/platform"
import { NodeFileSystem } from "@effect/platform-node"
import { DateTime, Effect, FiberRef, Layer } from "effect"
import {
  Application,
  AuthorizationService,
  DelegationPrincipal,
  Execution,
  FileRef,
  FormField,
  GraphQLField,
  ListRef,
  ProviderUserPrincipal,
  PublicLinkPrincipal,
  RoleRef,
  ServiceAccountPrincipal,
  Step,
  TodoRef,
} from "@pf/auth-policy"
import { RequestTime } from "@pf/request-time"
import {
  LocalCedarAuthorizationLive,
  LocalCedarConfig,
  LocalCedarConfigDefault,
  getDefaultPoliciesPath,
  getDefaultSchemaPath,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

// Create a fixed request time for testing
const fixedRequestTime = DateTime.unsafeMake(new Date("2024-06-15T10:30:00Z"))
const RequestTimeTest = Layer.effect(
  RequestTime,
  FiberRef.make(fixedRequestTime),
)

describe("LocalCedarAuthorization", () => {
  const AuthLayer = Layer.provide(LocalCedarAuthorizationLive, [
    LocalCedarConfigDefault(),
    RequestTimeTest,
  ])
  const TestLayer = Layer.merge(AuthLayer, RequestTimeTest)

  const runTest = <A, E>(
    test: Effect.Effect<A, E, AuthorizationService | RequestTime>,
  ): Promise<A> => {
    return Effect.runPromise(Effect.scoped(Effect.provide(test, TestLayer)))
  }

  const createTestLayerWithPolicy = (customPolicy: string) => {
    const authLayer = Layer.provide(LocalCedarAuthorizationLive, [
      Layer.effect(
        LocalCedarConfig,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const schemaText = yield* fs.readFileString(getDefaultSchemaPath())
          return {
            policiesText: [customPolicy],
            schemaText,
          }
        }),
      ).pipe(Layer.provide(NodeFileSystem.layer)),
      RequestTimeTest,
    ])
    return Layer.merge(authLayer, RequestTimeTest)
  }

  const application = new Application("pf-app")

  describe("delegation management", () => {
    const owner = new ProviderUserPrincipal("alice@example.com", {
      roles: ["/Administrator"],
      orgUnitId: "/",
    })
    const other = new ProviderUserPrincipal("bob@example.com", {
      roles: ["/Administrator"],
      orgUnitId: "/",
    })
    const evidence = (ageMillis: number, providerUserId = "alice-db-id") => ({
      humanSession: true,
      ownerProviderUserId: "alice-db-id",
      humanAuthentication: {
        providerUserId,
        authenticatedAt: DateTime.toEpochMillis(fixedRequestTime) - ageMillis,
        method: "passkey" as const,
      },
    })

    it("requires explicit self-listing and issuance grants while preserving cross-owner administrator inspection", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService
          expect(
            yield* auth.canIssueDelegationSecret(owner, owner, {
              ownerProviderUserId: "alice-db-id",
              humanSession: true,
            }),
          ).toBe(false)
          expect(yield* auth.canListDelegationTokens(owner, owner)).toBe(false)
          expect(
            yield* auth.canIssueDelegationSecret(other, owner, evidence(0)),
          ).toBe(false)
          expect(yield* auth.canListDelegationTokens(other, owner)).toBe(true)
          expect(
            yield* auth.canIssueDelegationSecret(
              new ServiceAccountPrincipal("frontend"),
              owner,
              evidence(0),
            ),
          ).toBe(false)
        }),
      ))

    for (const action of [
      "listDelegationTokens",
      "issueDelegationSecret",
    ] as const) {
      it(`honors a particular user's ${action} grant independently`, async () => {
        const policy = `permit (
          principal == PF::ProviderUser::"alice@example.com",
          action == PF::Action::"${action}",
          resource == PF::ProviderUser::"alice@example.com"
        );`
        await Effect.runPromise(
          Effect.gen(function* () {
            const auth = yield* AuthorizationService
            expect(yield* auth.canListDelegationTokens(owner, owner)).toBe(
              action === "listDelegationTokens",
            )
            expect(
              yield* auth.canIssueDelegationSecret(owner, owner, {
                ownerProviderUserId: "alice-db-id",
                humanSession: true,
              }),
            ).toBe(action === "issueDelegationSecret")
            const delegatedAdministrator = new DelegationPrincipal(
              "alice-delegation",
              {
                owner: owner.uid.id,
                name: "admin-agent",
                roles: ["/Administrator"],
                orgUnitId: "/",
              },
            )
            expect(
              yield* auth.canIssueDelegationSecret(
                delegatedAdministrator,
                owner,
                { ownerProviderUserId: "alice-db-id" },
              ),
            ).toBe(false)
          }).pipe(
            Effect.provide(createTestLayerWithPolicy(policy)),
            Effect.scoped,
          ),
        )
      })
    }

    it("lets the shared ownership forbid override a broad issuance permit without affecting listing", async () => {
      const config = Layer.effect(
        LocalCedarConfig,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          return {
            schemaText: yield* fs.readFileString(getDefaultSchemaPath()),
            policiesText: [
              yield* fs.readFileString(getDefaultPoliciesPath()),
              `
permit (principal == PF::ProviderUser::"bob@example.com",
    action in [PF::Action::"issueDelegationSecret", PF::Action::"listDelegationTokens"],
    resource == PF::ProviderUser::"alice@example.com");
`,
            ],
          }
        }),
      ).pipe(Layer.provide(NodeFileSystem.layer))
      await Effect.runPromise(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService
          expect(
            yield* auth.canIssueDelegationSecret(other, owner, {
              ownerProviderUserId: "alice-db-id",
            }),
          ).toBe(false)
          expect(
            yield* auth.canIssueDelegationSecret(
              other,
              owner,
              evidence(300001),
            ),
          ).toBe(false)
          expect(yield* auth.canListDelegationTokens(other, owner)).toBe(true)
        }).pipe(
          Effect.provide(
            Layer.merge(
              Layer.provide(LocalCedarAuthorizationLive, config),
              RequestTimeTest,
            ),
          ),
          Effect.scoped,
        ),
      )
    })
  })

  describe("canLogin", () => {
    it("should allow login for employee with role", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const alice = new ProviderUserPrincipal("alice", {
            roles: ["clerk"],
            orgUnitId: "finance",
          })

          const result = yield* auth.canLogin(alice, application)

          expect(result).toBe(true)
        }),
      ))

    it("should deny login for employee without roles", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const eve = new ProviderUserPrincipal("eve", {
            roles: [],
            orgUnitId: "finance",
          })

          const result = yield* auth.canLogin(eve, application)

          expect(result).toBe(false)
        }),
      ))

    it("should allow login for employee with multiple roles", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const bob = new ProviderUserPrincipal("bob", {
            roles: ["clerk", "manager"],
            orgUnitId: "finance",
          })

          const result = yield* auth.canLogin(bob, application)

          expect(result).toBe(true)
        }),
      ))
  })

  describe("canActOnBehalfOf", () => {
    it("denies act-on-behalf by default", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const service = new ServiceAccountPrincipal("frontend", [])
          const alice = new ProviderUserPrincipal("alice", {
            roles: ["clerk"],
            orgUnitId: "finance",
          })

          const result = yield* auth.canActOnBehalfOf(service, alice)

          expect(result).toBe(false)
        }),
      ))

    it("allows act-on-behalf when a custom policy permits it", async () => {
      const TestLayerWithActOnBehalf = createTestLayerWithPolicy(`
permit (
    principal == PF::ServiceAccount::"trusted-service",
    action == PF::Action::"actOnBehalfOf",
    resource is PF::ProviderUser
);
`)

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const auth = yield* AuthorizationService

            const service = new ServiceAccountPrincipal("trusted-service", [])
            const alice = new ProviderUserPrincipal("alice", {
              roles: ["clerk"],
              orgUnitId: "finance",
            })

            const result = yield* auth.canActOnBehalfOf(service, alice)

            expect(result).toBe(true)
          }).pipe(Effect.provide(TestLayerWithActOnBehalf)),
        ),
      )
    })

    it("allows provider users to act on behalf when a custom policy permits it", async () => {
      const TestLayerWithActOnBehalf = createTestLayerWithPolicy(`
permit (
    principal in PF::Role::"manager",
    action == PF::Action::"actOnBehalfOf",
    resource is PF::ProviderUser
);
`)

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const auth = yield* AuthorizationService

            const manager = new ProviderUserPrincipal("manager", {
              roles: ["manager"],
              orgUnitId: "finance",
            })
            const alice = new ProviderUserPrincipal("alice", {
              roles: ["clerk"],
              orgUnitId: "finance",
            })

            const result = yield* auth.canActOnBehalfOf(manager, alice)

            expect(result).toBe(true)
          }).pipe(Effect.provide(TestLayerWithActOnBehalf)),
        ),
      )
    })

    it("denies provider users who do not match the act-on-behalf policy", async () => {
      const TestLayerWithActOnBehalf = createTestLayerWithPolicy(`
permit (
    principal in PF::Role::"manager",
    action == PF::Action::"actOnBehalfOf",
    resource is PF::ProviderUser
);
`)

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const auth = yield* AuthorizationService

            const clerk = new ProviderUserPrincipal("clerk", {
              roles: ["clerk"],
              orgUnitId: "finance",
            })
            const alice = new ProviderUserPrincipal("alice", {
              roles: ["clerk"],
              orgUnitId: "finance",
            })

            const result = yield* auth.canActOnBehalfOf(clerk, alice)

            expect(result).toBe(false)
          }).pipe(Effect.provide(TestLayerWithActOnBehalf)),
        ),
      )
    })

    it("denies act-on-behalf when the custom policy does not match", async () => {
      const TestLayerWithActOnBehalf = createTestLayerWithPolicy(`
permit (
    principal == PF::ServiceAccount::"trusted-service",
    action == PF::Action::"actOnBehalfOf",
    resource is PF::ProviderUser
);
`)

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const auth = yield* AuthorizationService

            const service = new ServiceAccountPrincipal("unknown-service", [])
            const alice = new ProviderUserPrincipal("alice", {
              roles: ["clerk"],
              orgUnitId: "finance",
            })

            const result = yield* auth.canActOnBehalfOf(service, alice)

            expect(result).toBe(false)
          }).pipe(Effect.provide(TestLayerWithActOnBehalf)),
        ),
      )
    })
  })

  describe("canCompleteStep for start steps (startsProcess=true)", () => {
    it("should allow start for employee with matching role", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const alice = new ProviderUserPrincipal("alice", {
            roles: ["clerk"],
            orgUnitId: "finance",
          })

          // Start step with startsProcess=true
          const startStep = new Step({
            stepPath: "finance/time-off-request/Submit",
            rolePath: "clerk",
            processPath: "finance/time-off-request",
            startsProcess: true,
          })

          const result = yield* auth.canCompleteStep(alice, startStep)

          expect(result).toBe(true)
        }),
      ))

    it("should deny start for employee without matching role", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const alice = new ProviderUserPrincipal("alice", {
            roles: ["clerk"],
            orgUnitId: "finance",
          })

          // Start step requires manager role, but alice only has clerk
          const startStep = new Step({
            stepPath: "finance/budget-approval/Submit",
            rolePath: "manager",
            processPath: "finance/budget-approval",
            startsProcess: true,
          })

          const result = yield* auth.canCompleteStep(alice, startStep)

          expect(result).toBe(false)
        }),
      ))

    it("should allow start when employee has the required role among multiple", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const bob = new ProviderUserPrincipal("bob", {
            roles: ["clerk", "manager"],
            orgUnitId: "finance",
          })

          // Start step requires manager role - bob has it among his roles
          const startStep = new Step({
            stepPath: "finance/expense-report/Submit",
            rolePath: "manager",
            processPath: "finance/expense-report",
            startsProcess: true,
          })

          const result = yield* auth.canCompleteStep(bob, startStep)

          expect(result).toBe(true)
        }),
      ))

    it("should deny start for employee with no roles", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const eve = new ProviderUserPrincipal("eve", {
            roles: [],
            orgUnitId: "finance",
          })

          const startStep = new Step({
            stepPath: "finance/time-off-request/Submit",
            rolePath: "clerk",
            processPath: "finance/time-off-request",
            startsProcess: true,
          })

          const result = yield* auth.canCompleteStep(eve, startStep)

          expect(result).toBe(false)
        }),
      ))

    it("should deny start when step has no role assigned", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const alice = new ProviderUserPrincipal("alice", {
            roles: ["clerk"],
            orgUnitId: "finance",
          })

          // Start step has no role - nobody can start it
          const startStep = new Step({
            stepPath: "finance/restricted-process/Submit",
            processPath: "finance/restricted-process",
            startsProcess: true,
          })

          const result = yield* auth.canCompleteStep(alice, startStep)

          expect(result).toBe(false)
        }),
      ))
  })

  describe("canCompletePublicTodo", () => {
    it("allows a public link to complete its bound todo", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const result = yield* auth.canCompletePublicTodo(
            new PublicLinkPrincipal("todo-1"),
            new TodoRef("todo-1"),
          )

          expect(result).toBe(true)
        }),
      ))

    it("denies a public link completing a different todo", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const result = yield* auth.canCompletePublicTodo(
            new PublicLinkPrincipal("todo-1"),
            new TodoRef("todo-2"),
          )

          expect(result).toBe(false)
        }),
      ))
  })

  describe("canCompleteTodo", () => {
    it("allows a role holder to complete an unassigned todo", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const alice = new ProviderUserPrincipal("alice@example.com", {
            roles: ["/Employee"],
            orgUnitId: "/",
          })

          const result = yield* auth.canCompleteTodo(
            alice,
            new TodoRef("todo-1", {
              stepPath: "/key-request/Pickup",
              rolePath: "/Employee",
              processPath: "/key-request",
            }),
          )

          expect(result).toBe(true)
        }),
      ))

    it("narrows an assigned todo to the assigned provider user", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const assignee = new ProviderUserPrincipal("assignee@example.com", {
            roles: ["/Employee"],
            orgUnitId: "/",
          })
          const other = new ProviderUserPrincipal("other@example.com", {
            roles: ["/Employee"],
            orgUnitId: "/",
          })
          const todo = new TodoRef("todo-2", {
            stepPath: "/key-request/Pickup",
            rolePath: "/Employee",
            processPath: "/key-request",
            assignedToProviderUserEmail: "assignee@example.com",
          })

          expect(yield* auth.canCompleteTodo(assignee, todo)).toBe(true)
          expect(yield* auth.canCompleteTodo(other, todo)).toBe(false)
        }),
      ))

    it("allows a role-scoped service account to complete an unassigned todo", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const serviceAccount = new ServiceAccountPrincipal("ci-pipeline", [
            "/finance/Manager",
          ])

          const result = yield* auth.canCompleteTodo(
            serviceAccount,
            new TodoRef("todo-3", {
              stepPath: "/finance/purchase-request/Manager approval",
              rolePath: "/finance/Manager",
              processPath: "/finance/purchase-request",
            }),
          )

          expect(result).toBe(true)
        }),
      ))

    it("denies service accounts completing directly assigned todos by default", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const serviceAccount = new ServiceAccountPrincipal("ci-pipeline", [
            "/finance/Manager",
          ])

          const result = yield* auth.canCompleteTodo(
            serviceAccount,
            new TodoRef("todo-4", {
              stepPath: "/finance/purchase-request/Manager approval",
              rolePath: "/finance/Manager",
              processPath: "/finance/purchase-request",
              assignedToProviderUserEmail: "manager@example.com",
            }),
          )

          expect(result).toBe(false)
        }),
      ))
  })

  describe("canCorrectPublicCompletionTodo", () => {
    it("allows a role holder to correct a public completion todo", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const alice = new ProviderUserPrincipal("alice@example.com", {
            roles: ["/Employee"],
            orgUnitId: "/",
          })

          const result = yield* auth.canCorrectPublicCompletionTodo(
            alice,
            new TodoRef("todo-correction-1", {
              stepPath: "/key-request/Pickup",
              rolePath: "/Employee",
              processPath: "/key-request",
            }),
          )

          expect(result).toBe(true)
        }),
      ))

    it("narrows an assigned correction todo to the assigned provider user", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const assignee = new ProviderUserPrincipal("assignee@example.com", {
            roles: ["/Employee"],
            orgUnitId: "/",
          })
          const other = new ProviderUserPrincipal("other@example.com", {
            roles: ["/Employee"],
            orgUnitId: "/",
          })
          const todo = new TodoRef("todo-correction-2", {
            stepPath: "/key-request/Pickup",
            rolePath: "/Employee",
            processPath: "/key-request",
            assignedToProviderUserEmail: "assignee@example.com",
          })

          expect(
            yield* auth.canCorrectPublicCompletionTodo(assignee, todo),
          ).toBe(true)
          expect(yield* auth.canCorrectPublicCompletionTodo(other, todo)).toBe(
            false,
          )
        }),
      ))

    it("does not grant normal todo completion when only a correction role candidate is used", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const oversight = new ProviderUserPrincipal("oversight@example.com", {
            roles: ["/Oversight"],
            orgUnitId: "/",
          })
          const assignedTodo = new TodoRef("todo-correction-3", {
            stepPath: "/key-request/Pickup",
            rolePath: "/Oversight",
            processPath: "/key-request",
            assignedToProviderUserEmail: "assignee@example.com",
          })
          const correctionCandidateTodo = new TodoRef("todo-correction-3", {
            stepPath: "/key-request/Pickup",
            rolePath: "/Oversight",
            processPath: "/key-request",
          })

          expect(yield* auth.canCompleteTodo(oversight, assignedTodo)).toBe(
            false,
          )
          expect(
            yield* auth.canCorrectPublicCompletionTodo(
              oversight,
              correctionCandidateTodo,
            ),
          ).toBe(true)
        }),
      ))
  })

  describe("canCompleteStep for regular steps", () => {
    it("should allow complete for employee with matching role", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const alice = new ProviderUserPrincipal("alice", {
            roles: ["clerk"],
            orgUnitId: "finance",
          })

          const step = new Step({
            stepPath: "finance/expense-report/Submit Receipt",
            rolePath: "clerk",
            processPath: "finance/expense-report",
          })

          const result = yield* auth.canCompleteStep(alice, step)

          expect(result).toBe(true)
        }),
      ))

    it("should deny complete for employee without matching role", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const alice = new ProviderUserPrincipal("alice", {
            roles: ["clerk"],
            orgUnitId: "finance",
          })

          // Step requires manager role, but alice only has clerk
          const step = new Step({
            stepPath: "finance/budget-approval/Approve Budget",
            rolePath: "manager",
            processPath: "finance/budget-approval",
          })

          const result = yield* auth.canCompleteStep(alice, step)

          expect(result).toBe(false)
        }),
      ))

    it("should allow complete when employee has the required role among multiple", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const bob = new ProviderUserPrincipal("bob", {
            roles: ["clerk", "manager"],
            orgUnitId: "finance",
          })

          // Step requires manager - bob has it among his roles
          const step = new Step({
            stepPath: "finance/expense-report/Review Receipt",
            rolePath: "manager",
            processPath: "finance/expense-report",
          })

          const result = yield* auth.canCompleteStep(bob, step)

          expect(result).toBe(true)
        }),
      ))

    it("should deny complete for employee with no roles", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const eve = new ProviderUserPrincipal("eve", {
            roles: [],
            orgUnitId: "finance",
          })

          const step = new Step({
            stepPath: "finance/expense-report/Submit Receipt",
            rolePath: "clerk",
            processPath: "finance/expense-report",
          })

          const result = yield* auth.canCompleteStep(eve, step)

          expect(result).toBe(false)
        }),
      ))

    it("should deny complete when step has no role assigned", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const alice = new ProviderUserPrincipal("alice", {
            roles: ["clerk"],
            orgUnitId: "finance",
          })

          // Step has no role - nobody can complete it
          const step = new Step({
            stepPath: "finance/restricted/Restricted Step",
            processPath: "finance/restricted",
          })

          const result = yield* auth.canCompleteStep(alice, step)

          expect(result).toBe(false)
        }),
      ))

    it("should include startsProcess attribute for start steps", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const alice = new ProviderUserPrincipal("alice", {
            roles: ["clerk"],
            orgUnitId: "finance",
          })

          // A start step with startsProcess=true
          const startStep = new Step({
            stepPath: "finance/expense-report/Submit",
            rolePath: "clerk",
            processPath: "finance/expense-report",
            startsProcess: true,
          })

          const result = yield* auth.canCompleteStep(alice, startStep)

          expect(result).toBe(true)
        }),
      ))
  })

  describe("canModifyField", () => {
    it("excludes service accounts at the type level", () => {
      type ModifyFieldPrincipal = Parameters<
        AuthorizationService["Type"]["canModifyField"]
      >[0]
      type ServiceAccountsCanModifyFields =
        ServiceAccountPrincipal extends ModifyFieldPrincipal ? true : false

      const serviceAccountsCanModifyFields: ServiceAccountsCanModifyFields = false

      expect(serviceAccountsCanModifyFields).toBe(false)
    })

    it("allows modifying a field for an employee with the field role", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const alice = new ProviderUserPrincipal("alice", {
            roles: ["clerk"],
            orgUnitId: "finance",
          })
          const field = new FormField({
            stepPath: "finance/expense-report/Submit Receipt",
            fieldName: "receiptAmount",
            rolePath: "clerk",
            processPath: "finance/expense-report",
          })

          const result = yield* auth.canModifyField(alice, field)

          expect(result).toBe(true)
        }),
      ))

    it("denies modifying a field for an employee without the field role", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const alice = new ProviderUserPrincipal("alice", {
            roles: ["clerk"],
            orgUnitId: "finance",
          })
          const field = new FormField({
            stepPath: "finance/expense-report/Review Receipt",
            fieldName: "approved",
            rolePath: "manager",
            processPath: "finance/expense-report",
          })

          const result = yield* auth.canModifyField(alice, field)

          expect(result).toBe(false)
        }),
      ))

    it("denies modifying a field without a role", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const alice = new ProviderUserPrincipal("alice", {
            roles: ["clerk"],
            orgUnitId: "finance",
          })
          const field = new FormField({
            stepPath: "finance/expense-report/Internal",
            fieldName: "notes",
            processPath: "finance/expense-report",
          })

          const result = yield* auth.canModifyField(alice, field)

          expect(result).toBe(false)
        }),
      ))

    it("exposes step role to custom modify-field policies", async () => {
      const TestLayerWithStepRole = createTestLayerWithPolicy(`
permit (
    principal is PF::ProviderUser,
    action == PF::Action::"modifyField",
    resource is PF::FormField
)
when {
    resource.step.role == PF::Role::"manager"
};
`)

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const auth = yield* AuthorizationService

            const manager = new ProviderUserPrincipal("manager", {
              roles: ["manager"],
              orgUnitId: "finance",
            })
            const field = new FormField({
              stepPath: "finance/expense-report/Review Receipt",
              fieldName: "approved",
              rolePath: "clerk",
              stepRolePath: "manager",
              processPath: "finance/expense-report",
            })

            const result = yield* auth.canModifyField(manager, field)

            expect(result).toBe(true)
          }).pipe(Effect.provide(TestLayerWithStepRole)),
        ),
      )
    })

    it("exposes principal role to custom modify-field policies", async () => {
      const TestLayerWithPrincipalRole = createTestLayerWithPolicy(`
permit (
    principal in PF::Role::"manager",
    action == PF::Action::"modifyField",
    resource is PF::FormField
);
`)

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const auth = yield* AuthorizationService

            const manager = new ProviderUserPrincipal("manager", {
              roles: ["manager"],
              orgUnitId: "finance",
            })
            const field = new FormField({
              stepPath: "finance/expense-report/Review Receipt",
              fieldName: "approved",
              rolePath: "clerk",
              processPath: "finance/expense-report",
            })

            const result = yield* auth.canModifyField(manager, field)

            expect(result).toBe(true)
          }).pipe(Effect.provide(TestLayerWithPrincipalRole)),
        ),
      )
    })
  })

  describe("frontend embed permissions", () => {
    it("denies provider users without roles for embed-tagged GraphQL fields", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const eve = new ProviderUserPrincipal("eve", {
            roles: [],
            orgUnitId: "/school",
          })
          const field = new GraphQLField("Query.lookupSuggestions", "embed")

          const result = yield* auth.canAccessField(eve, field, "query")

          expect(result).toBe(false)
        }),
      ))

    // Internal authenticated forms still use lookupSuggestions, so provider
    // users keep access when the field is tagged for the frontend embed path.
    it("allows provider users to access embed-tagged GraphQL fields", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const alice = new ProviderUserPrincipal("alice", {
            roles: ["/Office Staff"],
            orgUnitId: "/school",
          })
          const field = new GraphQLField("Query.lookupSuggestions", "embed")

          const result = yield* auth.canAccessField(alice, field, "query")

          expect(result).toBe(true)
        }),
      ))

    it("allows frontend service account to access embed-tagged GraphQL fields", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const frontend = new ServiceAccountPrincipal("frontend", [])
          const field = new GraphQLField(
            "Mutation.startSchoolEnrolment",
            "embed",
          )

          const result = yield* auth.canAccessField(frontend, field, "mutation")

          expect(result).toBe(true)
        }),
      ))

    it("denies frontend service account for untagged GraphQL mutations", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const frontend = new ServiceAccountPrincipal("frontend", [])
          const field = new GraphQLField("Mutation.startSchoolEnrolment")

          const result = yield* auth.canAccessField(frontend, field, "mutation")

          expect(result).toBe(false)
        }),
      ))

    it("denies provider users default access to cron-tagged start mutations", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const alice = new ProviderUserPrincipal("alice", {
            roles: ["/Office Staff"],
            orgUnitId: "/school",
          })
          const field = new GraphQLField(
            "Mutation.startOperationsNightlySync",
            "cron",
          )

          const result = yield* auth.canAccessField(alice, field, "mutation")

          expect(result).toBe(false)
        }),
      ))

    it("allows scheduler service account to access cron-tagged GraphQL mutations", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const scheduler = new ServiceAccountPrincipal("scheduler", [])
          const field = new GraphQLField(
            "Mutation.startOperationsNightlySync",
            "cron",
          )

          const result = yield* auth.canAccessField(
            scheduler,
            field,
            "mutation",
          )

          expect(result).toBe(true)
        }),
      ))

    it("denies scheduler service account for untagged GraphQL mutations", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const scheduler = new ServiceAccountPrincipal("scheduler", [])
          const field = new GraphQLField("Mutation.startOperationsNightlySync")

          const result = yield* auth.canAccessField(
            scheduler,
            field,
            "mutation",
          )

          expect(result).toBe(false)
        }),
      ))

    it("allows frontend service account to start embedded steps only", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const frontend = new ServiceAccountPrincipal("frontend", [])
          const embeddedStep = new Step({
            stepPath: "/school/enrolment/Submit enquiry",
            rolePath: "/Office Staff",
            processPath: "/school/enrolment",
            startsProcess: true,
            embedded: true,
          })
          const regularStep = new Step({
            stepPath: "/school/key-request/Submit",
            rolePath: "/Employee",
            processPath: "/school/key-request",
            startsProcess: true,
          })

          const canStartEmbedded = yield* auth.canCompleteStep(
            frontend,
            embeddedStep,
          )
          const canStartRegular = yield* auth.canCompleteStep(
            frontend,
            regularStep,
          )

          expect(canStartEmbedded).toBe(true)
          expect(canStartRegular).toBe(false)
        }),
      ))

    it("allows scheduler service account to start role-less start steps only", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const scheduler = new ServiceAccountPrincipal("scheduler", [])
          const cronStartStep = new Step({
            stepPath: "/operations/nightly-sync/Start",
            processPath: "/operations/nightly-sync",
            startsProcess: true,
          })
          const regularStartStep = new Step({
            stepPath: "/operations/manual-sync/Start",
            rolePath: "/Employee",
            processPath: "/operations/manual-sync",
            startsProcess: true,
          })
          const nonStartSystemStep = new Step({
            stepPath: "/operations/nightly-sync/Run",
            processPath: "/operations/nightly-sync",
          })

          const canStartCron = yield* auth.canCompleteStep(
            scheduler,
            cronStartStep,
          )
          const canStartRegular = yield* auth.canCompleteStep(
            scheduler,
            regularStartStep,
          )
          const canCompleteNonStart = yield* auth.canCompleteStep(
            scheduler,
            nonStartSystemStep,
          )

          expect(canStartCron).toBe(true)
          expect(canStartRegular).toBe(false)
          expect(canCompleteNonStart).toBe(false)
        }),
      ))
  })

  describe("canCompleteStep for service accounts", () => {
    const serviceAccountStartPolicy = `
// Keep default provider-user login policy
permit (
    principal is PF::ProviderUser,
    action == PF::Action::"login",
    resource is PF::Application
)
when {
    principal.roles.isEmpty() == false
};

// Allow website service account to start one specific process
permit (
    principal == PF::ServiceAccount::"website",
    action == PF::Action::"complete",
    resource == PF::Step::"/enrolment-enquiry/Submit enquiry"
)
when {
    resource.startsProcess
};
`

    it("should allow a permitted service account to start a specific step", async () => {
      const testLayer = createTestLayerWithPolicy(serviceAccountStartPolicy)

      await Effect.runPromise(
        Effect.scoped(
          Effect.provide(
            Effect.gen(function* () {
              const auth = yield* AuthorizationService
              const website = new ServiceAccountPrincipal("website", [])
              const startStep = new Step({
                stepPath: "/enrolment-enquiry/Submit enquiry",
                rolePath: "/Employee",
                processPath: "/enrolment-enquiry",
                startsProcess: true,
              })

              const result = yield* auth.canCompleteStep(website, startStep)

              expect(result).toBe(true)
            }),
            testLayer,
          ),
        ),
      )
    })

    it("should deny that service account for other steps", async () => {
      const testLayer = createTestLayerWithPolicy(serviceAccountStartPolicy)

      await Effect.runPromise(
        Effect.scoped(
          Effect.provide(
            Effect.gen(function* () {
              const auth = yield* AuthorizationService
              const website = new ServiceAccountPrincipal("website", [])
              const otherStartStep = new Step({
                stepPath: "/key-request/Request",
                rolePath: "/Employee",
                processPath: "/key-request",
                startsProcess: true,
              })

              const result = yield* auth.canCompleteStep(
                website,
                otherStartStep,
              )

              expect(result).toBe(false)
            }),
            testLayer,
          ),
        ),
      )
    })

    it("should deny that service account for the same step when it is not a start step", async () => {
      const testLayer = createTestLayerWithPolicy(serviceAccountStartPolicy)

      await Effect.runPromise(
        Effect.scoped(
          Effect.provide(
            Effect.gen(function* () {
              const auth = yield* AuthorizationService
              const website = new ServiceAccountPrincipal("website", [])
              const nonStartStep = new Step({
                stepPath: "/enrolment-enquiry/Submit enquiry",
                rolePath: "/Employee",
                processPath: "/enrolment-enquiry",
                startsProcess: false,
              })

              const result = yield* auth.canCompleteStep(website, nonStartStep)

              expect(result).toBe(false)
            }),
            testLayer,
          ),
        ),
      )
    })
  })

  describe("startsProcess attribute in policies", () => {
    // Custom policy that allows completing only start steps
    const startsProcessPolicy = `
// Allow alice to complete only start steps
permit (
    principal == PF::ProviderUser::"alice",
    action == PF::Action::"complete",
    resource is PF::Step
)
when {
    resource.startsProcess
};

// Keep other policies for login etc
permit (
    principal is PF::ProviderUser,
    action == PF::Action::"login",
    resource is PF::Application
)
when {
    principal.roles.isEmpty() == false
};
`

    // Create a test layer with the custom policy
    it("should allow completing a start step via 'resource.startsProcess' policy", async () => {
      const TestLayerWithStartsProcess =
        createTestLayerWithPolicy(startsProcessPolicy)

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const auth = yield* AuthorizationService

            const alice = new ProviderUserPrincipal("alice", {
              roles: [],
              orgUnitId: "finance",
            })

            // Start step (startsProcess=true) - should be allowed
            const startStep = new Step({
              stepPath: "finance/expense-report/Submit",
              rolePath: "",
              processPath: "finance/expense-report",
              startsProcess: true,
            })

            const result = yield* auth.canCompleteStep(alice, startStep)
            expect(result).toBe(true)
          }).pipe(Effect.provide(TestLayerWithStartsProcess)),
        ),
      )
    })

    it("should deny completing a non-start step via 'resource.startsProcess' policy", async () => {
      const TestLayerWithStartsProcess =
        createTestLayerWithPolicy(startsProcessPolicy)

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const auth = yield* AuthorizationService

            const alice = new ProviderUserPrincipal("alice", {
              roles: [],
              orgUnitId: "finance",
            })

            // Non-start step (startsProcess=false) - should be denied
            const regularStep = new Step({
              stepPath: "finance/expense-report/Review",
              rolePath: "",
              processPath: "finance/expense-report",
              startsProcess: false,
            })

            const result = yield* auth.canCompleteStep(alice, regularStep)
            expect(result).toBe(false)
          }).pipe(Effect.provide(TestLayerWithStartsProcess)),
        ),
      )
    })
  })

  describe("resource in Process hierarchy", () => {
    // Custom policy that allows completing any step in a specific process
    const processHierarchyPolicy = `
// Allow alice to complete any step in the expense-report process
permit (
    principal == PF::ProviderUser::"alice",
    action == PF::Action::"complete",
    resource in PF::Process::"finance/expense-report"
);

// Keep other policies for login etc
permit (
    principal is PF::ProviderUser,
    action == PF::Action::"login",
    resource is PF::Application
)
when {
    principal.roles.isEmpty() == false
};
`

    // Create a test layer with the custom policy
    it("should allow completing any step in a process via 'resource in Process' policy", async () => {
      const TestLayerWithHierarchy = createTestLayerWithPolicy(
        processHierarchyPolicy,
      )

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const auth = yield* AuthorizationService

            const alice = new ProviderUserPrincipal("alice", {
              roles: [],
              orgUnitId: "finance",
            })

            // Step has no role, but alice is permitted via process hierarchy
            const step1 = new Step({
              stepPath: "finance/expense-report/Submit",
              rolePath: "",
              processPath: "finance/expense-report",
            })

            const result1 = yield* auth.canCompleteStep(alice, step1)
            expect(result1).toBe(true)

            // Another step in the same process should also be allowed
            const step2 = new Step({
              stepPath: "finance/expense-report/Review",
              rolePath: "",
              processPath: "finance/expense-report",
            })

            const result2 = yield* auth.canCompleteStep(alice, step2)
            expect(result2).toBe(true)
          }).pipe(Effect.provide(TestLayerWithHierarchy)),
        ),
      )
    })

    it("should deny completing steps in a different process", async () => {
      const TestLayerWithHierarchy = createTestLayerWithPolicy(
        processHierarchyPolicy,
      )

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const auth = yield* AuthorizationService

            const alice = new ProviderUserPrincipal("alice", {
              roles: [],
              orgUnitId: "finance",
            })

            // Step in a different process - should be denied
            const step = new Step({
              stepPath: "finance/budget-approval/Submit",
              rolePath: "",
              processPath: "finance/budget-approval",
            })

            const result = yield* auth.canCompleteStep(alice, step)
            expect(result).toBe(false)
          }).pipe(Effect.provide(TestLayerWithHierarchy)),
        ),
      )
    })

    it("should deny other users from completing steps in the permitted process", async () => {
      const TestLayerWithHierarchy = createTestLayerWithPolicy(
        processHierarchyPolicy,
      )

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const auth = yield* AuthorizationService

            // Bob is not alice, so should be denied
            const bob = new ProviderUserPrincipal("bob", {
              roles: ["clerk"],
              orgUnitId: "finance",
            })

            const step = new Step({
              stepPath: "finance/expense-report/Submit",
              rolePath: "",
              processPath: "finance/expense-report",
            })

            const result = yield* auth.canCompleteStep(bob, step)
            expect(result).toBe(false)
          }).pipe(Effect.provide(TestLayerWithHierarchy)),
        ),
      )
    })
  })

  describe("resource in OrgUnit hierarchy", () => {
    // Custom policy that allows completing any step in a specific org unit
    const orgUnitHierarchyPolicy = `
// Allow alice to complete any step in processes belonging to the finance org unit
permit (
    principal == PF::ProviderUser::"alice",
    action == PF::Action::"complete",
    resource in PF::OrgUnit::"finance"
);

// Keep other policies for login etc
permit (
    principal is PF::ProviderUser,
    action == PF::Action::"login",
    resource is PF::Application
)
when {
    principal.roles.isEmpty() == false
};
`

    // Create a test layer with the custom policy
    it("should allow completing any step in a process belonging to the org unit via 'resource in OrgUnit' policy", async () => {
      const TestLayerWithHierarchy = createTestLayerWithPolicy(
        orgUnitHierarchyPolicy,
      )

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const auth = yield* AuthorizationService

            const alice = new ProviderUserPrincipal("alice", {
              roles: [],
              orgUnitId: "finance",
            })

            // Step in finance/expense-report process, which belongs to finance org unit
            const step1 = new Step({
              stepPath: "finance/expense-report/Submit",
              rolePath: "",
              processPath: "finance/expense-report",
            })

            const result1 = yield* auth.canCompleteStep(alice, step1)
            expect(result1).toBe(true)

            // Another step in a different process but same org unit
            const step2 = new Step({
              stepPath: "finance/budget-approval/Review",
              rolePath: "",
              processPath: "finance/budget-approval",
            })

            const result2 = yield* auth.canCompleteStep(alice, step2)
            expect(result2).toBe(true)
          }).pipe(Effect.provide(TestLayerWithHierarchy)),
        ),
      )
    })

    it("should deny completing steps in processes belonging to a different org unit", async () => {
      const TestLayerWithHierarchy = createTestLayerWithPolicy(
        orgUnitHierarchyPolicy,
      )

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const auth = yield* AuthorizationService

            const alice = new ProviderUserPrincipal("alice", {
              roles: [],
              orgUnitId: "finance",
            })

            // Step in hr/time-off process, which belongs to hr org unit - should be denied
            const step = new Step({
              stepPath: "hr/time-off/Submit",
              rolePath: "",
              processPath: "hr/time-off",
            })

            const result = yield* auth.canCompleteStep(alice, step)
            expect(result).toBe(false)
          }).pipe(Effect.provide(TestLayerWithHierarchy)),
        ),
      )
    })

    it("should deny other users from completing steps in the permitted org unit", async () => {
      const TestLayerWithHierarchy = createTestLayerWithPolicy(
        orgUnitHierarchyPolicy,
      )

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const auth = yield* AuthorizationService

            // Bob is not alice, so should be denied
            const bob = new ProviderUserPrincipal("bob", {
              roles: ["clerk"],
              orgUnitId: "finance",
            })

            const step = new Step({
              stepPath: "finance/expense-report/Submit",
              rolePath: "",
              processPath: "finance/expense-report",
            })

            const result = yield* auth.canCompleteStep(bob, step)
            expect(result).toBe(false)
          }).pipe(Effect.provide(TestLayerWithHierarchy)),
        ),
      )
    })
  })

  describe("canRequestRole", () => {
    it("should allow requesting a role the employee already has", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const alice = new ProviderUserPrincipal("alice", {
            roles: ["clerk", "manager"],
            orgUnitId: "finance",
          })

          const roleRef = new RoleRef("clerk")
          const result = yield* auth.canRequestRole(alice, roleRef)

          expect(result).toBe(true)
        }),
      ))

    it("should allow requesting another role the employee has", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const alice = new ProviderUserPrincipal("alice", {
            roles: ["clerk", "manager"],
            orgUnitId: "finance",
          })

          const roleRef = new RoleRef("manager")
          const result = yield* auth.canRequestRole(alice, roleRef)

          expect(result).toBe(true)
        }),
      ))

    it("should deny requesting a role the employee does not have", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const alice = new ProviderUserPrincipal("alice", {
            roles: ["clerk"],
            orgUnitId: "finance",
          })

          const roleRef = new RoleRef("manager")
          const result = yield* auth.canRequestRole(alice, roleRef)

          expect(result).toBe(false)
        }),
      ))

    it("should deny requesting for employee with no roles", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const eve = new ProviderUserPrincipal("eve", {
            roles: [],
            orgUnitId: "finance",
          })

          const roleRef = new RoleRef("clerk")
          const result = yield* auth.canRequestRole(eve, roleRef)

          expect(result).toBe(false)
        }),
      ))
  })

  describe("canRequestRole with custom policy", () => {
    // Custom policy that allows Alice to request any role
    const customRequestRolePolicy = `
// Employees can request any role they already have
permit (
    principal is PF::ProviderUser,
    action == PF::Action::"requestRole",
    resource is PF::Role
)
when {
    principal.roles.contains(resource)
};

// Alice can request any role (including ones he doesn't have)
permit (
    principal == PF::ProviderUser::"alice@example.com",
    action == PF::Action::"requestRole",
    resource is PF::Role
);

// Keep other policies for login etc
permit (
    principal is PF::ProviderUser,
    action == PF::Action::"login",
    resource is PF::Application
)
when {
    principal.roles.isEmpty() == false
};
`

    it("should allow alice@example.com to request any role via custom policy", async () => {
      const TestLayerWithCustomPolicy = createTestLayerWithPolicy(
        customRequestRolePolicy,
      )

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const auth = yield* AuthorizationService

            const alice = new ProviderUserPrincipal("alice@example.com", {
              roles: ["clerk"], // Only has clerk role
              orgUnitId: "finance",
            })

            // Should be able to request manager role even though he doesn't have it
            const roleRef = new RoleRef("manager")
            const result = yield* auth.canRequestRole(alice, roleRef)

            expect(result).toBe(true)
          }).pipe(Effect.provide(TestLayerWithCustomPolicy)),
        ),
      )
    })

    it("should deny other employees from requesting roles they don't have", async () => {
      const TestLayerWithCustomPolicy = createTestLayerWithPolicy(
        customRequestRolePolicy,
      )

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const auth = yield* AuthorizationService

            const alice = new ProviderUserPrincipal("alice", {
              roles: ["clerk"],
              orgUnitId: "finance",
            })

            // Alice should not be able to request manager role
            const roleRef = new RoleRef("manager")
            const result = yield* auth.canRequestRole(alice, roleRef)

            expect(result).toBe(false)
          }).pipe(Effect.provide(TestLayerWithCustomPolicy)),
        ),
      )
    })
  })

  describe("canViewExecution", () => {
    it("should allow viewing execution started by the employee", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const alice = new ProviderUserPrincipal("alice", {
            roles: ["/Clerk"],
            orgUnitId: "/Finance/",
          })

          const execution = new Execution(
            "pex-123",
            "alice", // started by alice
            "/Finance/expense-report",
            ["/Finance/"], // org units from completed steps
          )

          const result = yield* auth.canViewExecution(alice, execution)
          expect(result).toBe(true)
        }),
      ))

    it("should deny viewing execution in same org unit if not started by employee", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const alice = new ProviderUserPrincipal("alice", {
            roles: ["/Clerk"],
            orgUnitId: "/Finance/",
          })

          // Execution started by bob - alice cannot view just because she's in same org unit
          // (would expose sensitive processes like disciplinary actions)
          const execution = new Execution(
            "pex-456",
            "bob", // started by bob
            "/Finance/expense-report",
            ["/Finance/"], // org units from completed steps
          )

          const result = yield* auth.canViewExecution(alice, execution)
          expect(result).toBe(false)
        }),
      ))

    it("should deny viewing execution started under office staff role without a policy", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const alice = new ProviderUserPrincipal("alice", {
            roles: ["/Office Staff"],
            orgUnitId: "/",
          })

          const execution = new Execution(
            "pex-office-staff",
            "bob",
            "/career-guidance",
            ["/"],
            "/Office Staff",
          )

          const result = yield* auth.canViewExecution(alice, execution)
          expect(result).toBe(false)
        }),
      ))

    it("should allow custom policies to view executions by started role", async () => {
      const TestLayerWithExecutionRolePolicy = createTestLayerWithPolicy(`
permit (
    principal in PF::Role::"/Senior Office Staff",
    action == PF::Action::"view",
    resource is PF::Execution
)
when {
    resource has startedByRole &&
    resource.startedByRole == PF::Role::"/Office Staff"
};
`)

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const auth = yield* AuthorizationService

            const alice = new ProviderUserPrincipal("alice", {
              roles: ["/Senior Office Staff"],
              orgUnitId: "/",
            })

            const execution = new Execution(
              "pex-office-staff",
              "bob",
              "/career-guidance",
              ["/"],
              "/Office Staff",
            )

            const result = yield* auth.canViewExecution(alice, execution)
            expect(result).toBe(true)
          }).pipe(Effect.provide(TestLayerWithExecutionRolePolicy)),
        ),
      )
    })

    it("should deny viewing execution in different org unit not started by employee", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const alice = new ProviderUserPrincipal("alice", {
            roles: ["/Clerk"],
            orgUnitId: "/Finance/",
          })

          // Execution in HR, not started by alice
          const execution = new Execution(
            "pex-789",
            "bob",
            "/HR/time-off-request",
            ["/HR/"], // org units from completed steps - not matching alice's org unit
          )

          const result = yield* auth.canViewExecution(alice, execution)
          expect(result).toBe(false)
        }),
      ))

    it("should deny viewing for employee with no roles in different org unit", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const eve = new ProviderUserPrincipal("eve", {
            roles: [],
            orgUnitId: "/Marketing/",
          })

          // Execution in finance, not started by eve
          const execution = new Execution(
            "pex-000",
            "alice",
            "/Finance/expense-report",
            ["/Finance/"], // org units from completed steps
          )

          const result = yield* auth.canViewExecution(eve, execution)
          expect(result).toBe(false)
        }),
      ))

    it("should deny viewing execution with steps in multiple org units when not started by employee", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          // Alice is in Finance department
          const alice = new ProviderUserPrincipal("alice", {
            roles: ["/Clerk"],
            orgUnitId: "/Finance/",
          })

          // Execution spans multiple org units (Finance and HR)
          // Alice cannot view just because one of the steps was in her org unit
          const execution = new Execution(
            "pex-multi",
            "bob", // started by someone else
            "/cross-dept/approval-process",
            ["/HR/", "/Finance/"], // steps completed in both org units
          )

          const result = yield* auth.canViewExecution(alice, execution)
          expect(result).toBe(false)
        }),
      ))

    it("should deny viewing execution when employee org unit not in any completed step org units", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          // Alice is in Finance department
          const alice = new ProviderUserPrincipal("alice", {
            roles: ["/Clerk"],
            orgUnitId: "/Finance/",
          })

          // Execution has steps in HR and Marketing, but not Finance
          const execution = new Execution(
            "pex-other",
            "bob",
            "/cross-dept/approval-process",
            ["/HR/", "/Marketing/"], // no Finance org unit
          )

          const result = yield* auth.canViewExecution(alice, execution)
          expect(result).toBe(false)
        }),
      ))

    it("should deny viewing system-started execution without a starter", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const alice = new ProviderUserPrincipal("alice", {
            roles: ["/Clerk"],
            orgUnitId: "/Finance/",
          })

          const execution = new Execution(
            "pex-system",
            null,
            "/Finance/system-process",
            ["/Finance/"],
          )

          const result = yield* auth.canViewExecution(alice, execution)
          expect(result).toBe(false)
        }),
      ))
  })

  describe("canRestartExecution", () => {
    it("should deny restarting an execution the employee started", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const alice = new ProviderUserPrincipal("alice", {
            roles: ["/Clerk"],
            orgUnitId: "/Finance/",
          })

          const execution = new Execution(
            "pex-123",
            "alice",
            "/Finance/expense-report",
            ["/Finance/"],
          )

          const result = yield* auth.canRestartExecution(alice, execution)
          expect(result).toBe(false)
        }),
      ))
  })

  describe("canAccessFeature viewAuthorization", () => {
    it("should deny viewing authorisation by default", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService
          const alice = new ProviderUserPrincipal("alice", {
            roles: ["/Administrator"],
            orgUnitId: "/",
          })
          const result = yield* auth.canAccessFeature(
            alice,
            new Application("default"),
            "viewAuthorization",
          )
          expect(result).toBe(false)
        }),
      ))
  })

  describe("canAccessFeature", () => {
    // Custom policy for feature-based authorization
    const featureAccessPolicy = `
// Allow employees with Administrator role to administer users
permit (
    principal in PF::Role::"/Administrator",
    action == PF::Action::"administerUsers",
    resource is PF::Application
);

// Allow employees with Administrator role to administer OAuth providers
permit (
    principal in PF::Role::"/Administrator",
    action == PF::Action::"administerOAuthProviders",
    resource is PF::Application
);

// Allow employees with Administrator role to create Database Shell sessions
permit (
    principal in PF::Role::"/Administrator",
    action == PF::Action::"databaseShell",
    resource is PF::Application
);

// Only human Administrators may recover existing accounts
permit (
    principal is PF::ProviderUser in PF::Role::"/Administrator",
    action == PF::Action::"recoverProviderUser",
    resource is PF::Application
);

// Allow employees with Administrator role to administer project stage config
permit (
    principal in PF::Role::"/Administrator",
    action == PF::Action::"administerProjectStageConfig",
    resource is PF::Application
);

// Allow employees with Administrator role to view authorisation
permit (
    principal in PF::Role::"/Administrator",
    action == PF::Action::"viewAuthorization",
    resource is PF::Application
);

// Allow customers to coordinate database transfer artifacts
permit (
    principal in PF::Role::"/Customer",
    action == PF::Action::"databaseTransfer",
    resource is PF::Application
);

// Allow ci-pipeline service account to administer users
permit (
    principal == PF::ServiceAccount::"ci-pipeline",
    action == PF::Action::"administerUsers",
    resource is PF::Application
);

// Keep login policy
permit (
    principal is PF::ProviderUser,
    action == PF::Action::"login",
    resource is PF::Application
)
when {
    principal.roles.isEmpty() == false
};
`

    it("should allow Administrator to access administerUsers feature", async () => {
      const TestLayerWithFeature =
        createTestLayerWithPolicy(featureAccessPolicy)

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const auth = yield* AuthorizationService

            const admin = new ProviderUserPrincipal("admin@example.com", {
              roles: ["/Administrator"],
              orgUnitId: "/",
            })

            const application = new Application("default")
            const result = yield* auth.canAccessFeature(
              admin,
              application,
              "administerUsers",
            )

            expect(result).toBe(true)
          }).pipe(Effect.provide(TestLayerWithFeature)),
        ),
      )
    })

    it("requires explicit recovery authority independently of user administration", async () => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const auth = yield* AuthorizationService
            const application = new Application("default")
            const admin = new ProviderUserPrincipal("admin@example.com", {
              roles: ["/Administrator"],
              orgUnitId: "/",
            })
            const customer = new ProviderUserPrincipal("customer@example.com", {
              roles: ["/Customer"],
              orgUnitId: "/",
            })
            expect(
              yield* auth.canAccessFeature(
                admin,
                application,
                "recoverProviderUser",
              ),
            ).toBe(true)
            expect(
              yield* auth.canAccessFeature(
                customer,
                application,
                "recoverProviderUser",
              ),
            ).toBe(false)
          }).pipe(
            Effect.provide(createTestLayerWithPolicy(featureAccessPolicy)),
          ),
        ),
      )
      await runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService
          const admin = new ProviderUserPrincipal("admin@example.com", {
            roles: ["/Administrator"],
            orgUnitId: "/",
          })
          expect(
            yield* auth.canAccessFeature(
              admin,
              new Application("default"),
              "recoverProviderUser",
            ),
          ).toBe(false)
        }),
      )
    })

    it("should allow Administrator to access administerOAuthProviders feature", async () => {
      const TestLayerWithFeature =
        createTestLayerWithPolicy(featureAccessPolicy)

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const auth = yield* AuthorizationService

            const admin = new ProviderUserPrincipal("admin@example.com", {
              roles: ["/Administrator"],
              orgUnitId: "/",
            })

            const application = new Application("default")
            const result = yield* auth.canAccessFeature(
              admin,
              application,
              "administerOAuthProviders",
            )

            expect(result).toBe(true)
          }).pipe(Effect.provide(TestLayerWithFeature)),
        ),
      )
    })

    it("should allow Administrator to access databaseShell feature", async () => {
      const TestLayerWithFeature =
        createTestLayerWithPolicy(featureAccessPolicy)

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const auth = yield* AuthorizationService

            const admin = new ProviderUserPrincipal("admin@example.com", {
              roles: ["/Administrator"],
              orgUnitId: "/",
            })

            const application = new Application("default")
            const result = yield* auth.canAccessFeature(
              admin,
              application,
              "databaseShell",
            )

            expect(result).toBe(true)
          }).pipe(Effect.provide(TestLayerWithFeature)),
        ),
      )
    })

    it("should allow Administrator to administer project stage config", async () => {
      const TestLayerWithFeature =
        createTestLayerWithPolicy(featureAccessPolicy)

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const auth = yield* AuthorizationService
            const admin = new ProviderUserPrincipal("admin@example.com", {
              roles: ["/Administrator"],
              orgUnitId: "/",
            })

            const result = yield* auth.canAccessFeature(
              admin,
              new Application("default"),
              "administerProjectStageConfig",
            )

            expect(result).toBe(true)
          }).pipe(Effect.provide(TestLayerWithFeature)),
        ),
      )
    })

    it("should allow Administrator to view authorisation", async () => {
      const TestLayerWithFeature =
        createTestLayerWithPolicy(featureAccessPolicy)

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const auth = yield* AuthorizationService
            const admin = new ProviderUserPrincipal("admin@example.com", {
              roles: ["/Administrator"],
              orgUnitId: "/",
            })

            const result = yield* auth.canAccessFeature(
              admin,
              new Application("default"),
              "viewAuthorization",
            )

            expect(result).toBe(true)
          }).pipe(Effect.provide(TestLayerWithFeature)),
        ),
      )
    })

    it("should deny non-Administrator from accessing administerUsers feature", async () => {
      const TestLayerWithFeature =
        createTestLayerWithPolicy(featureAccessPolicy)

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const auth = yield* AuthorizationService

            const employee = new ProviderUserPrincipal("employee@example.com", {
              roles: ["/Employee"],
              orgUnitId: "/finance",
            })

            const application = new Application("default")
            const result = yield* auth.canAccessFeature(
              employee,
              application,
              "administerUsers",
            )

            expect(result).toBe(false)
          }).pipe(Effect.provide(TestLayerWithFeature)),
        ),
      )
    })

    it("should deny non-Administrator from accessing administerOAuthProviders feature", async () => {
      const TestLayerWithFeature =
        createTestLayerWithPolicy(featureAccessPolicy)

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const auth = yield* AuthorizationService

            const employee = new ProviderUserPrincipal("employee@example.com", {
              roles: ["/Employee"],
              orgUnitId: "/finance",
            })

            const application = new Application("default")
            const result = yield* auth.canAccessFeature(
              employee,
              application,
              "administerOAuthProviders",
            )

            expect(result).toBe(false)
          }).pipe(Effect.provide(TestLayerWithFeature)),
        ),
      )
    })

    it("should deny non-Administrator from accessing databaseShell feature", async () => {
      const TestLayerWithFeature =
        createTestLayerWithPolicy(featureAccessPolicy)

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const auth = yield* AuthorizationService

            const customer = new ProviderUserPrincipal("customer@example.com", {
              roles: ["/Customer"],
              orgUnitId: "/",
            })

            const application = new Application("default")
            const result = yield* auth.canAccessFeature(
              customer,
              application,
              "databaseShell",
            )

            expect(result).toBe(false)
          }).pipe(Effect.provide(TestLayerWithFeature)),
        ),
      )
    })

    it("should deny Employee project stage config administration", async () => {
      const TestLayerWithFeature =
        createTestLayerWithPolicy(featureAccessPolicy)

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const auth = yield* AuthorizationService
            const employee = new ProviderUserPrincipal("employee@example.com", {
              roles: ["/Employee"],
              orgUnitId: "/",
            })

            const result = yield* auth.canAccessFeature(
              employee,
              new Application("default"),
              "administerProjectStageConfig",
            )

            expect(result).toBe(false)
          }).pipe(Effect.provide(TestLayerWithFeature)),
        ),
      )
    })

    it("should not let databaseTransfer authorize databaseShell", async () => {
      const TestLayerWithFeature =
        createTestLayerWithPolicy(featureAccessPolicy)

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const auth = yield* AuthorizationService

            const customer = new ProviderUserPrincipal("customer@example.com", {
              roles: ["/Customer"],
              orgUnitId: "/",
            })

            const application = new Application("default")
            const canTransfer = yield* auth.canAccessFeature(
              customer,
              application,
              "databaseTransfer",
            )
            const canShell = yield* auth.canAccessFeature(
              customer,
              application,
              "databaseShell",
            )

            expect(canTransfer).toBe(true)
            expect(canShell).toBe(false)
          }).pipe(Effect.provide(TestLayerWithFeature)),
        ),
      )
    })

    it("should allow ServiceAccount to access permitted features", async () => {
      const TestLayerWithFeature =
        createTestLayerWithPolicy(featureAccessPolicy)

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const auth = yield* AuthorizationService

            const ciPipeline = new ServiceAccountPrincipal("ci-pipeline", [])

            const application = new Application("default")
            const result = yield* auth.canAccessFeature(
              ciPipeline,
              application,
              "administerUsers",
            )

            expect(result).toBe(true)
          }).pipe(Effect.provide(TestLayerWithFeature)),
        ),
      )
    })

    it("should deny ServiceAccount from non-permitted features", async () => {
      const TestLayerWithFeature =
        createTestLayerWithPolicy(featureAccessPolicy)

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const auth = yield* AuthorizationService

            // ci-pipeline is not permitted to administer OAuth providers
            const ciPipeline = new ServiceAccountPrincipal("ci-pipeline", [])

            const application = new Application("default")
            const result = yield* auth.canAccessFeature(
              ciPipeline,
              application,
              "administerOAuthProviders",
            )

            expect(result).toBe(false)
          }).pipe(Effect.provide(TestLayerWithFeature)),
        ),
      )
    })

    it("should deny unknown ServiceAccount from features", async () => {
      const TestLayerWithFeature =
        createTestLayerWithPolicy(featureAccessPolicy)

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const auth = yield* AuthorizationService

            const unknownService = new ServiceAccountPrincipal(
              "unknown-service",
              [],
            )

            const application = new Application("default")
            const result = yield* auth.canAccessFeature(
              unknownService,
              application,
              "administerUsers",
            )

            expect(result).toBe(false)
          }).pipe(Effect.provide(TestLayerWithFeature)),
        ),
      )
    })
  })

  describe("canAccessList", () => {
    it("should allow access for employee with matching role", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const employee = new ProviderUserPrincipal("alice", {
            roles: ["clerk"],
            orgUnitId: "finance",
          })

          const list = new ListRef("finance/employees", ["clerk"])
          const result = yield* auth.canAccessList(employee, list)

          expect(result).toBe(true)
        }),
      ))

    it("should deny access for employee without matching role", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const employee = new ProviderUserPrincipal("bob", {
            roles: ["manager"],
            orgUnitId: "finance",
          })

          const list = new ListRef("finance/employees", ["clerk"])
          const result = yield* auth.canAccessList(employee, list)

          expect(result).toBe(false)
        }),
      ))

    it("should allow when employee has matching role among multiple roles", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const employee = new ProviderUserPrincipal("charlie", {
            roles: ["manager", "clerk", "admin"],
            orgUnitId: "finance",
          })

          const list = new ListRef("finance/employees", ["clerk"])
          const result = yield* auth.canAccessList(employee, list)

          expect(result).toBe(true)
        }),
      ))

    it("should allow when employee has one of the list roles", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const employee = new ProviderUserPrincipal("dana", {
            roles: ["manager"],
            orgUnitId: "finance",
          })

          const list = new ListRef("finance/employees", ["clerk", "manager"])
          const result = yield* auth.canAccessList(employee, list)

          expect(result).toBe(true)
        }),
      ))

    it("should deny when employee has none of the list roles", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const employee = new ProviderUserPrincipal("dana", {
            roles: ["accountant"],
            orgUnitId: "finance",
          })

          const list = new ListRef("finance/employees", ["clerk", "manager"])
          const result = yield* auth.canAccessList(employee, list)

          expect(result).toBe(false)
        }),
      ))

    it("should deny for employee with no roles", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const employee = new ProviderUserPrincipal("nobody", {
            roles: [],
            orgUnitId: "finance",
          })

          const list = new ListRef("finance/employees", ["clerk"])
          const result = yield* auth.canAccessList(employee, list)

          expect(result).toBe(false)
        }),
      ))
  })

  describe("canCreateList", () => {
    const employee = new ProviderUserPrincipal("alice", {
      roles: ["clerk"],
      orgUnitId: "finance",
    })
    const list = new ListRef("finance/employees", ["clerk"])

    it("denies creation by default even when viewing is allowed", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService
          expect(yield* auth.canAccessList(employee, list)).toBe(true)
          expect(yield* auth.canCreateList(employee, list)).toBe(false)
        }),
      ))

    it.each([false, true])(
      "honors an explicit create permit with forbid=%s",
      async (forbidden) => {
        const policy = `
permit (
  principal is PF::ProviderUser,
  action == PF::Action::"create",
  resource == PF::List::"finance/employees"
);
${forbidden ? 'forbid (principal, action == PF::Action::"create", resource is PF::List);' : ""}
`
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const auth = yield* AuthorizationService
              expect(yield* auth.canCreateList(employee, list)).toBe(!forbidden)
              expect(
                yield* auth.canCreateList(
                  employee,
                  new ListRef("finance/other", ["clerk"]),
                ),
              ).toBe(false)
            }).pipe(Effect.provide(createTestLayerWithPolicy(policy))),
          ),
        )
      },
    )
  })

  describe("canAccessList with custom policy", () => {
    const orgUnitPolicy = `
// Allow viewing lists in the school org unit
permit (
    principal is PF::ProviderUser,
    action == PF::Action::"view",
    resource is PF::List
)
when {
    resource in PF::OrgUnit::"school"
};

// Keep login policy
permit (
    principal is PF::ProviderUser,
    action == PF::Action::"login",
    resource is PF::Application
)
when {
    principal.roles.isEmpty() == false
};
`

    it("should allow querying list in permitted org unit", async () => {
      const TestLayerWithPolicy = createTestLayerWithPolicy(orgUnitPolicy)

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const auth = yield* AuthorizationService

            const employee = new ProviderUserPrincipal("teacher", {
              roles: ["teacher"],
              orgUnitId: "school",
            })

            const list = new ListRef("school/students", ["teacher"], "school")
            const result = yield* auth.canAccessList(employee, list)

            expect(result).toBe(true)
          }).pipe(Effect.provide(TestLayerWithPolicy)),
        ),
      )
    })

    it("should deny querying list in different org unit", async () => {
      const TestLayerWithPolicy = createTestLayerWithPolicy(orgUnitPolicy)

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const auth = yield* AuthorizationService

            const employee = new ProviderUserPrincipal("teacher", {
              roles: ["teacher"],
              orgUnitId: "school",
            })

            const list = new ListRef(
              "hospital/patients",
              ["doctor"],
              "hospital",
            )
            const result = yield* auth.canAccessList(employee, list)

            expect(result).toBe(false)
          }).pipe(Effect.provide(TestLayerWithPolicy)),
        ),
      )
    })
  })

  describe("canDownloadFile", () => {
    it("should allow file owner to download their own file", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const alice = new ProviderUserPrincipal("alice", {
            roles: ["clerk"],
            orgUnitId: "finance",
          })

          // File owned by alice in public document store
          const file = new FileRef(
            "file-123",
            "alice",
            "finance",
            "/public/docs",
          )
          const result = yield* auth.canDownloadFile(alice, file)

          expect(result).toBe(true)
        }),
      ))

    it("should deny non-owner from downloading file with system policies only", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const bob = new ProviderUserPrincipal("bob", {
            roles: ["clerk"],
            orgUnitId: "finance",
          })

          // File owned by alice, bob tries to download
          const file = new FileRef(
            "file-123",
            "alice",
            "finance",
            "/public/docs",
          )
          const result = yield* auth.canDownloadFile(bob, file)

          expect(result).toBe(false)
        }),
      ))

    it("should deny non-owner even with same org unit", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const bob = new ProviderUserPrincipal("bob", {
            roles: ["clerk"],
            orgUnitId: "finance",
          })

          // File owned by alice in same org unit, bob tries to download
          const file = new FileRef(
            "file-123",
            "alice",
            "finance",
            "/public/docs",
          )
          const result = yield* auth.canDownloadFile(bob, file)

          expect(result).toBe(false)
        }),
      ))
  })

  describe("canDownloadFile with forbid policy (cloud/org style)", () => {
    // Forbid policy that explicitly denies non-owners
    const forbidDownloadPolicy = `
// File owners can download their own files.
permit (
    principal is PF::ProviderUser,
    action == PF::Action::"download",
    resource is PF::File
)
when {
    principal == resource.owner
};

// Only the file owner can download files (forbid all others)
forbid (
    principal is PF::ProviderUser,
    action == PF::Action::"download",
    resource is PF::File
)
unless {
    principal == resource.owner
};

// Keep login policy
permit (
    principal is PF::ProviderUser,
    action == PF::Action::"login",
    resource is PF::Application
)
when {
    principal.roles.isEmpty() == false
};
`

    it("should allow owner to download even with forbid policy", async () => {
      const TestLayerWithForbid =
        createTestLayerWithPolicy(forbidDownloadPolicy)

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const auth = yield* AuthorizationService

            const alice = new ProviderUserPrincipal("alice", {
              roles: ["clerk"],
              orgUnitId: "finance",
            })

            // File owned by alice in public document store
            const file = new FileRef(
              "file-123",
              "alice",
              "finance",
              "/public/docs",
            )
            const result = yield* auth.canDownloadFile(alice, file)

            expect(result).toBe(true)
          }).pipe(Effect.provide(TestLayerWithForbid)),
        ),
      )
    })

    it("should deny non-owner when forbid policy is present", async () => {
      const TestLayerWithForbid =
        createTestLayerWithPolicy(forbidDownloadPolicy)

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const auth = yield* AuthorizationService

            const bob = new ProviderUserPrincipal("bob", {
              roles: ["clerk"],
              orgUnitId: "finance",
            })

            // File owned by alice, bob tries to download
            const file = new FileRef(
              "file-123",
              "alice",
              "finance",
              "/public/docs",
            )
            const result = yield* auth.canDownloadFile(bob, file)

            expect(result).toBe(false)
          }).pipe(Effect.provide(TestLayerWithForbid)),
        ),
      )
    })
  })

  describe("canDownloadFile with org-unit sharing policy (no forbid)", () => {
    // Org-unit based sharing policy - no forbid
    const orgUnitSharingPolicy = `
// File owners can download their own files.
permit (
    principal is PF::ProviderUser,
    action == PF::Action::"download",
    resource is PF::File
)
when {
    principal == resource.owner
};

// Employees can download files in their org unit
permit (
    principal is PF::ProviderUser,
    action == PF::Action::"download",
    resource is PF::File
)
when {
    resource in principal.orgUnit
};

// Keep login policy
permit (
    principal is PF::ProviderUser,
    action == PF::Action::"login",
    resource is PF::Application
)
when {
    principal.roles.isEmpty() == false
};
`

    it("should allow owner to download with org-unit policy", async () => {
      const TestLayerWithOrgUnit =
        createTestLayerWithPolicy(orgUnitSharingPolicy)

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const auth = yield* AuthorizationService

            const alice = new ProviderUserPrincipal("alice", {
              roles: ["clerk"],
              orgUnitId: "finance",
            })

            // File owned by alice in public document store
            const file = new FileRef(
              "file-123",
              "alice",
              "finance",
              "/public/docs",
            )
            const result = yield* auth.canDownloadFile(alice, file)

            expect(result).toBe(true)
          }).pipe(Effect.provide(TestLayerWithOrgUnit)),
        ),
      )
    })

    it("should allow same-org-unit employee to download", async () => {
      const TestLayerWithOrgUnit =
        createTestLayerWithPolicy(orgUnitSharingPolicy)

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const auth = yield* AuthorizationService

            const bob = new ProviderUserPrincipal("bob", {
              roles: ["clerk"],
              orgUnitId: "finance",
            })

            // File owned by alice, but bob is in same org unit
            const file = new FileRef(
              "file-123",
              "alice",
              "finance",
              "/public/docs",
            )
            const result = yield* auth.canDownloadFile(bob, file)

            expect(result).toBe(true)
          }).pipe(Effect.provide(TestLayerWithOrgUnit)),
        ),
      )
    })

    it("should deny different-org-unit employee from downloading", async () => {
      const TestLayerWithOrgUnit =
        createTestLayerWithPolicy(orgUnitSharingPolicy)

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const auth = yield* AuthorizationService

            const charlie = new ProviderUserPrincipal("charlie", {
              roles: ["clerk"],
              orgUnitId: "hr",
            })

            // File in finance, charlie is in hr
            const file = new FileRef(
              "file-123",
              "alice",
              "finance",
              "/public/docs",
            )
            const result = yield* auth.canDownloadFile(charlie, file)

            expect(result).toBe(false)
          }).pipe(Effect.provide(TestLayerWithOrgUnit)),
        ),
      )
    })
  })

  describe("canDownloadFile with document-store based policy", () => {
    // Document store based sharing policy
    const documentStorePolicy = `
// File owners can download their own files.
permit (
    principal is PF::ProviderUser,
    action == PF::Action::"download",
    resource is PF::File
)
when {
    principal == resource.owner
};

// Anyone can download from public document stores
permit (
    principal is PF::ProviderUser,
    action == PF::Action::"download",
    resource is PF::File
)
when {
    resource.documentStore == "/public/docs"
};

// Keep login policy
permit (
    principal is PF::ProviderUser,
    action == PF::Action::"login",
    resource is PF::Application
)
when {
    principal.roles.isEmpty() == false
};
`

    it("should allow non-owner to download from public document store", async () => {
      const TestLayerWithDocStore =
        createTestLayerWithPolicy(documentStorePolicy)

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const auth = yield* AuthorizationService

            const bob = new ProviderUserPrincipal("bob", {
              roles: ["clerk"],
              orgUnitId: "finance",
            })

            // File owned by alice in public document store
            const file = new FileRef("file-123", "alice", "hr", "/public/docs")
            const result = yield* auth.canDownloadFile(bob, file)

            expect(result).toBe(true)
          }).pipe(Effect.provide(TestLayerWithDocStore)),
        ),
      )
    })

    it("should deny non-owner from private document store", async () => {
      const TestLayerWithDocStore =
        createTestLayerWithPolicy(documentStorePolicy)

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const auth = yield* AuthorizationService

            const bob = new ProviderUserPrincipal("bob", {
              roles: ["clerk"],
              orgUnitId: "finance",
            })

            // File owned by alice in private document store
            const file = new FileRef(
              "file-123",
              "alice",
              "hr",
              "/private/confidential",
            )
            const result = yield* auth.canDownloadFile(bob, file)

            expect(result).toBe(false)
          }).pipe(Effect.provide(TestLayerWithDocStore)),
        ),
      )
    })

    it("should allow owner to download from any document store", async () => {
      const TestLayerWithDocStore =
        createTestLayerWithPolicy(documentStorePolicy)

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const auth = yield* AuthorizationService

            const alice = new ProviderUserPrincipal("alice", {
              roles: ["clerk"],
              orgUnitId: "hr",
            })

            // File owned by alice in private document store
            const file = new FileRef(
              "file-123",
              "alice",
              "hr",
              "/private/confidential",
            )
            const result = yield* auth.canDownloadFile(alice, file)

            expect(result).toBe(true)
          }).pipe(Effect.provide(TestLayerWithDocStore)),
        ),
      )
    })
  })

  describe("canDeleteFile", () => {
    it("should allow file owner to delete their own file", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const alice = new ProviderUserPrincipal("alice", {
            roles: ["clerk"],
            orgUnitId: "finance",
          })

          // File owned by alice in public document store
          const file = new FileRef(
            "file-123",
            "alice",
            "finance",
            "/public/docs",
          )
          const result = yield* auth.canDeleteFile(alice, file)

          expect(result).toBe(true)
        }),
      ))

    it("should deny non-owner from deleting file with system policies only", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          const bob = new ProviderUserPrincipal("bob", {
            roles: ["clerk"],
            orgUnitId: "finance",
          })

          // File owned by alice, bob tries to delete
          const file = new FileRef(
            "file-123",
            "alice",
            "finance",
            "/public/docs",
          )
          const result = yield* auth.canDeleteFile(bob, file)

          expect(result).toBe(false)
        }),
      ))

    it("should deny non-owner from different org unit", () =>
      runTest(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService

          // Bob is in HR, not Finance where the file belongs
          const bob = new ProviderUserPrincipal("bob", {
            roles: ["clerk"],
            orgUnitId: "hr",
          })

          // File owned by alice in Finance, bob from HR tries to delete
          const file = new FileRef(
            "file-123",
            "alice",
            "finance",
            "/public/docs",
          )
          const result = yield* auth.canDeleteFile(bob, file)

          expect(result).toBe(false)
        }),
      ))
  })
})
