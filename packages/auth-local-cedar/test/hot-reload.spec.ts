import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { DateTime, Deferred, Effect, Layer } from "effect"
import {
  ActivePolicyRevision,
  Application,
  AuthorizationService,
  PolicyRevisionPublisher,
  PolicyRevisionUnavailable,
  ProviderUserPrincipal,
} from "@pf/auth-policy"
import { RequestTime } from "@pf/request-time"
import {
  LocalCedarAuthorizationLive,
  LocalCedarConfigHotReload,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const fixedRequestTime = DateTime.makeUnsafe(new Date("2024-06-15T10:30:00Z"))
const RequestTimeTest = Layer.effect(
  RequestTime,
  Effect.succeed(fixedRequestTime),
)

const waitForFeatureAccess = (
  auth: AuthorizationService["Type"],
  principal: ProviderUserPrincipal,
  application: Application,
  action: "administerOAuthProviders" | "showProcessState",
  expected: boolean,
) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const result = yield* auth.canAccessFeature(
        principal,
        application,
        action,
      )
      if (result === expected) {
        return result
      }
      yield* Effect.sleep("100 millis")
    }

    return yield* Effect.fail(
      new Error(
        `Timed out waiting for ${action} authorization to become ${expected}`,
      ),
    )
  })

describe("LocalCedarAuthorization hot reload", () => {
  it("reloads changes from custom Cedar policy files", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "cedar-hot-reload-"))
    const customPolicyPath = path.join(tempDir, "custom.cedar")

    const initialPolicy = `permit (
    principal in PF::Role::"/Administrator",
    action == PF::Action::"administerOAuthProviders",
    resource is PF::Application
);
`

    const updatedPolicy = `permit (
    principal in PF::Role::"/Administrator",
    action == PF::Action::"showProcessState",
    resource is PF::Application
);
`

    await writeFile(customPolicyPath, initialPolicy, "utf8")

    let published = ""
    let rejectPublication = false
    const rejected = Effect.runSync(Deferred.make<void>())
    const AuthorizationLayer = Layer.provide(
      LocalCedarAuthorizationLive,
      Layer.merge(
        LocalCedarConfigHotReload(tempDir, ["custom.cedar"]),
        Layer.succeed(PolicyRevisionPublisher, {
          publish: (revision) =>
            Effect.suspend(() =>
              rejectPublication
                ? Deferred.succeed(rejected, undefined).pipe(
                    Effect.andThen(
                      Effect.fail(new PolicyRevisionUnavailable()),
                    ),
                  )
                : Effect.sync(() => {
                    published = revision
                  }),
            ),
        }),
      ),
    )
    const TestLayer = Layer.merge(AuthorizationLayer, RequestTimeTest)
    const program = Effect.gen(function* () {
      const auth = yield* AuthorizationService
      const revision = yield* ActivePolicyRevision
      const initialRevision = yield* revision.current
      expect(published).toBe(initialRevision)
      const application = new Application("pf-app")
      const administrator = new ProviderUserPrincipal("alice", {
        roles: ["/Administrator"],
        orgUnitId: "finance",
      })

      const beforeReload = yield* auth.canAccessFeature(
        administrator,
        application,
        "administerOAuthProviders",
      )
      expect(beforeReload).toBe(true)

      const beforeShowProcessState = yield* auth.canAccessFeature(
        administrator,
        application,
        "showProcessState",
      )
      expect(beforeShowProcessState).toBe(false)

      rejectPublication = true
      yield* Effect.promise(() =>
        writeFile(customPolicyPath, updatedPolicy, "utf8"),
      )
      yield* Deferred.await(rejected).pipe(Effect.timeout("5 seconds"))
      expect(yield* revision.current).toBe(initialRevision)
      expect(published).toBe(initialRevision)
      expect(
        yield* auth.canAccessFeature(
          administrator,
          application,
          "administerOAuthProviders",
        ),
      ).toBe(true)
      rejectPublication = false

      yield* Effect.promise(() =>
        writeFile(
          customPolicyPath,
          `${updatedPolicy}\n// retry activation`,
          "utf8",
        ),
      )

      const afterReload = yield* waitForFeatureAccess(
        auth,
        administrator,
        application,
        "administerOAuthProviders",
        false,
      )
      expect(afterReload).toBe(false)

      const afterShowProcessState = yield* waitForFeatureAccess(
        auth,
        administrator,
        application,
        "showProcessState",
        true,
      )
      expect(afterShowProcessState).toBe(true)
      expect(yield* revision.current).not.toBe(initialRevision)
      expect(published).toBe(yield* revision.current)
    })

    try {
      await Effect.runPromise(Effect.scoped(Effect.provide(program, TestLayer)))
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})
