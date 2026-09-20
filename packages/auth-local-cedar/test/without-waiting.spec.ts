import { readFileSync } from "node:fs"
import { DateTime, Effect, FiberRef, Layer } from "effect"
import {
  AuthorizationService,
  DelegationPrincipal,
  Execution,
  ProcessRef,
  ProviderUserPrincipal,
  ServiceAccountPrincipal,
} from "@pf/auth-policy"
import { RequestTime } from "@pf/request-time"
import {
  LocalCedarAuthorizationLive,
  LocalCedarConfig,
  getDefaultPoliciesPath,
  getDefaultSchemaPath,
} from "../src"
import { describe, expect, it } from "bun:test"

const time = Layer.effect(
  RequestTime,
  FiberRef.make(DateTime.unsafeMake("2026-09-14T00:00:00Z")),
)
const demoPolicy = readFileSync(
  new URL("../../../examples/demo/cedar/custom.cedar", import.meta.url),
  "utf8",
)
const layer = (policy: string) =>
  Layer.provide(
    LocalCedarAuthorizationLive,
    Layer.succeed(LocalCedarConfig, {
      schemaText: readFileSync(getDefaultSchemaPath(), "utf8"),
      policiesText: [readFileSync(getDefaultPoliciesPath(), "utf8"), policy],
    }),
  )
const human = new ProviderUserPrincipal("admin@example.com", {
  roles: ["/Administrator"],
  orgUnitId: "/",
})
const delegation = new DelegationPrincipal("delegation", {
  owner: "admin@example.com",
  name: "Agent",
  roles: ["/Administrator"],
  orgUnitId: "/",
})
const account = new ServiceAccountPrincipal("automation", ["/Administrator"])
const action = { type: "PF::Action", id: "skipScheduleWaits" }

describe("Without Waiting Cedar permission", () => {
  it("explicitly grants demo human Administrators, excluding inherited Delegations and Service Accounts", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService
          const process = new ProcessRef("/hr/on-boarding")
          expect(yield* auth.canPerformAction(human, process, action)).toBe(
            true,
          )
          expect(
            yield* auth.canPerformAction(delegation, process, action),
          ).toBe(false)
          expect(yield* auth.canPerformAction(account, process, action)).toBe(
            false,
          )
          expect(
            yield* auth.canPerformAction(
              new ProviderUserPrincipal("employee@example.com", {
                roles: ["/Employee"],
                orgUnitId: "/",
              }),
              process,
              action,
            ),
          ).toBe(false)
        }).pipe(Effect.provide(layer(demoPolicy)), Effect.provide(time)),
      ),
    )
  })

  for (const [scope, allowed] of [
    ['== PF::Process::"/hr/on-boarding"', true],
    ['== PF::Process::"/hr/other"', false],
    ['in PF::OrgUnit::"/hr"', true],
    ['in PF::OrgUnit::"/"', true],
    ['in PF::OrgUnit::"/finance"', false],
  ] as const) {
    it(`respects process and organisation ancestry: ${scope}`, async () => {
      const policy = `permit(principal, action == PF::Action::"skipScheduleWaits", resource ${scope});`
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const auth = yield* AuthorizationService
            expect(
              yield* auth.canPerformAction(
                account,
                new ProcessRef("/hr/on-boarding"),
                action,
              ),
            ).toBe(allowed)
          }).pipe(Effect.provide(layer(policy)), Effect.provide(time)),
        ),
      )
    })
  }
})

describe("Explicit caller grants on canonical Process identities", () => {
  const ciPolicy = readFileSync(
    new URL("../../../examples/demo/cedar/ci.cedar", import.meta.url),
    "utf8",
  )
  for (const [email, allowedPaths] of [
    [
      "employee@example.com",
      ["/hr/on-boarding", "/hr/automation/scheduled-start"],
    ],
    [
      "finance-manager@example.com",
      [
        "/hr/on-boarding",
        "/hr/automation/scheduled-start",
        "/hr/time-off-request",
      ],
    ],
    [
      "procurement-manager@example.com",
      [
        "/hr/on-boarding",
        "/hr/automation/scheduled-start",
        "/hr/time-off-request",
        "/operations/scheduled-start",
      ],
    ],
  ] as const) {
    it(`uses the actual human and Delegation for ${email}`, async () => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const auth = yield* AuthorizationService
            const principals = [
              new ProviderUserPrincipal(email, {
                roles: ["/Employee"],
                orgUnitId: "/",
              }),
              new DelegationPrincipal("immutable-delegation-id", {
                owner: email,
                name: "Renamable agent",
                roles: ["/Employee"],
                orgUnitId: "/",
              }),
            ]
            for (const principal of principals) {
              for (const path of [
                "/hr/on-boarding",
                "/hr/automation/scheduled-start",
                "/hr/time-off-request",
                "/operations/scheduled-start",
              ]) {
                expect(
                  yield* auth.canPerformAction(
                    principal,
                    new ProcessRef(path),
                    action,
                  ),
                ).toBe(allowedPaths.some((allowed) => allowed === path))
              }
            }
          }).pipe(Effect.provide(layer(ciPolicy)), Effect.provide(time)),
        ),
      )
    })
  }
  it("does not treat a start-step path or mutable display name as the exact Process identity", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService
          for (const id of [
            "/hr/on-boarding/Send welcome pack",
            "Onboard a new employee",
          ]) {
            expect(
              yield* auth.canPerformAction(account, new ProcessRef(id), action),
            ).toBe(false)
          }
          expect(
            yield* auth.canPerformAction(
              account,
              new ProcessRef("/hr/on-boarding"),
              action,
            ),
          ).toBe(true)
        }).pipe(
          Effect.provide(
            layer(
              'permit(principal, action == PF::Action::"skipScheduleWaits", resource == PF::Process::"/hr/on-boarding");',
            ),
          ),
          Effect.provide(time),
        ),
      ),
    )
  })
})

describe("Execution presentation preserves Service Account identity", () => {
  it("honors explicit viewing grants without turning a Service Account into a human", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const auth = yield* AuthorizationService
          const resource = new Execution(
            "execution",
            null,
            "/hr/on-boarding",
            [],
            null,
          )
          expect(yield* auth.canViewExecution(account, resource)).toBe(true)
          expect(
            yield* auth.canViewExecution(
              new ProviderUserPrincipal("automation", {
                roles: ["/Administrator"],
                orgUnitId: "/",
              }),
              resource,
            ),
          ).toBe(false)
        }).pipe(
          Effect.provide(
            layer(
              'permit(principal == PF::ServiceAccount::"automation", action == PF::Action::"view", resource is PF::Execution);',
            ),
          ),
          Effect.provide(time),
        ),
      ),
    )
  })
})
