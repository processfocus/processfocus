import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { validate } from "@cedar-policy/cedar-wasm/nodejs"
import { DateTime, Effect, Layer } from "effect"
import {
  Application,
  AuthorizationService,
  ProviderUserPrincipal,
} from "@pf/auth-policy"
import { RequestTime } from "@pf/request-time"
import {
  LocalCedarAuthorizationLive,
  LocalCedarConfig,
  getDefaultSchemaPath,
} from "../../src/index"

const schema = readFileSync(getDefaultSchemaPath(), "utf8")
const weekdays = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
]
const principal = new ProviderUserPrincipal("alice@example.com", {
  roles: [],
  orgUnitId: "/",
})
const application = new Application("pf-app")

for (const [index, weekday] of weekdays.entries()) {
  // Auckland is UTC+13 in January: Sunday UTC becomes Monday locally, etc.
  const utcDay = String(4 + index).padStart(2, "0")
  const localDay = String(5 + index).padStart(2, "0")
  const policy = `permit (principal, action, resource) when {
    context.weekday == "${weekday}" &&
    context.requestTime == datetime("2026-01-${localDay}T02:30:00.000Z")
  };`
  // Unrestricted action scope checks every schema context, including completion
  // and delegation issuance, rather than just the login context.
  const validation = validate({ schema, policies: { staticPolicies: policy } })
  assert.equal(validation.type, "success")
  if (validation.type === "success") {
    assert.deepEqual(validation.validationErrors, [])
  }
  await Effect.runPromise(
    Effect.gen(function* () {
      const auth = yield* AuthorizationService
      const requestTime = DateTime.makeUnsafe(`2026-01-${utcDay}T13:30:00Z`)
      assert.equal(
        yield* auth
          .canLogin(principal, application)
          .pipe(Effect.provideService(RequestTime, requestTime)),
        true,
        weekday,
      )
      assert.equal(
        yield* auth
          .canLogin(principal, application)
          .pipe(
            Effect.provideService(
              RequestTime,
              DateTime.add(requestTime, { days: 1 }),
            ),
          ),
        false,
        "a different local date must not reuse the previous context",
      )
    }).pipe(
      Effect.provide(
        LocalCedarAuthorizationLive.pipe(
          Layer.provide(
            Layer.succeed(LocalCedarConfig, {
              schemaText: schema,
              policiesText: [policy],
            }),
          ),
        ),
      ),
      Effect.scoped,
    ),
  )
}
