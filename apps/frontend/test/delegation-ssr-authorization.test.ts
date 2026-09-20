import { readFileSync } from "node:fs"
import { DateTime, Effect, FiberRef, Layer } from "effect"
import {
  LocalCedarAuthorizationLive,
  LocalCedarConfig,
  getDefaultPoliciesPath,
  getDefaultSchemaPath,
} from "@pf/auth-local-cedar"
import { RequestTime } from "@pf/request-time"
import { expect, mock, test } from "bun:test"

mock.module("server-only", () => ({}))
const { checkFeaturePermissions } = await import(
  "../lib/effect/services/authorization"
)
const human = {
  userId: "owner",
  email: "owner@example.test",
  roles: ["/Administrator"],
  orgUnitId: "org",
  orgUnitPath: "/",
}
const session = {
  ...human,
  delegation: {
    id: "immutable-delegate",
    generationId: "generation",
    name: "agent",
    expiresAt: 2_000_000_000_000,
  },
}
const requestTime = Layer.effect(
  RequestTime,
  FiberRef.make(DateTime.unsafeMake("2026-09-07T12:00:00Z")),
)
const run = (policy: string, delegated = true) =>
  Effect.runPromise(
    checkFeaturePermissions(delegated ? session : human).pipe(
      Effect.provide(
        Layer.merge(
          requestTime,
          LocalCedarAuthorizationLive.pipe(
            Layer.provide([
              requestTime,
              Layer.succeed(LocalCedarConfig, {
                policiesText: [
                  readFileSync(getDefaultPoliciesPath(), "utf8"),
                  policy,
                ],
                schemaText: readFileSync(getDefaultSchemaPath(), "utf8"),
              }),
            ]),
          ),
        ),
      ),
      Effect.scoped,
    ),
  )

test("SSR Cedar preserves the delegation principal and permits explicit organisation overrides", async () => {
  const result = await run(
    'permit(principal == PF::Delegation::"immutable-delegate", action == PF::Action::"administerUsers", resource);',
  )
  expect(result.administerUsers).toBe(true)
})

test("owner equality remains human-only while owner membership includes delegation", async () => {
  const equality =
    'permit(principal == PF::ProviderUser::"owner@example.test", action == PF::Action::"administerUsers", resource);'
  expect((await run(equality)).administerUsers).toBe(false)
  expect((await run(equality, false)).administerUsers).toBe(true)
  expect(
    (
      await run(
        'permit(principal in PF::ProviderUser::"owner@example.test", action == PF::Action::"administerUsers", resource);',
      )
    ).administerUsers,
  ).toBe(true)
})
