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
} from "../src/index"
import { afterEach, describe, expect, it } from "bun:test"

const schema = readFileSync(getDefaultSchemaPath(), "utf8")
const reference = readFileSync(
  new URL(
    "../../../apps/www/src/content/docs/docs/cloud/cedar-policies.mdx",
    import.meta.url,
  ),
  "utf8",
)
const examples = [
  ...reference
    .split("## Permission for a specific environment")[1]!
    .matchAll(/```cedar\n([\s\S]*?)```/g),
].map((match) => match[1]!)
const [productionForbid, stagingPermit, localPermit] = examples
const alice = new ProviderUserPrincipal("alice@example.com", {
  roles: [],
  orgUnitId: "/",
})
const bob = new ProviderUserPrincipal("bob@example.com", {
  roles: [],
  orgUnitId: "/",
})
const app = new Application("pf-app")
const loginPermit = `permit (principal, action == PF::Action::"login", resource);`

const evaluate = (policies: readonly string[]) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const auth = yield* AuthorizationService
      return {
        login: yield* auth.canLogin(alice, app),
        administer: yield* auth.canAccessFeature(bob, app, "administerUsers"),
      }
    }).pipe(
      Effect.provide(
        LocalCedarAuthorizationLive.pipe(
          Layer.provide(
            Layer.succeed(LocalCedarConfig, {
              schemaText: schema,
              policiesText: policies,
            }),
          ),
        ),
      ),
      Effect.provideService(
        RequestTime,
        DateTime.makeUnsafe("2026-01-01T12:00:00Z"),
      ),
      Effect.scoped,
    ),
  )

const keys = ["PF_RUNTIME_MODE", "PF_STAGE", "PF_ENV", "NODE_ENV"] as const
const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
afterEach(() => {
  for (const key of keys) {
    const value = original[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe("deployment-aware Cedar policies", () => {
  it("validates context fields for every action, including specialised contexts", () => {
    const result = validate({
      schema,
      policies: {
        staticPolicies: [
          ...examples,
          `permit (principal, action, resource)
        when { context.runtimeMode == "deployed" && context.stage == "production" &&
          context.environment == "stage" && context.nodeEnv == "production" };`,
        ].join("\n"),
      },
    })
    expect(result).toMatchObject({ type: "success", validationErrors: [] })
    expect(examples).toHaveLength(3)
  })

  it.each([
    {
      name: "local without metadata",
      mode: "local",
      stage: undefined,
      env: undefined,
      node: "production",
      login: true,
      staging: false,
      local: true,
    },
    {
      name: "local with production metadata",
      mode: "local",
      stage: "production",
      env: "prod",
      node: "production",
      login: true,
      staging: false,
      local: true,
    },
    {
      name: "deployed production",
      mode: "deployed",
      stage: "production",
      env: "prod",
      node: "development",
      login: false,
      staging: false,
      local: false,
    },
    {
      name: "deployed staging",
      mode: "deployed",
      stage: "production",
      env: "stage",
      node: "production",
      login: true,
      staging: true,
      local: false,
    },
    {
      name: "different stage",
      mode: "deployed",
      stage: "preview",
      env: "stage",
      node: "production",
      login: true,
      staging: false,
      local: false,
    },
    {
      name: "missing stage",
      mode: "deployed",
      stage: undefined,
      env: "stage",
      node: "production",
      login: true,
      staging: false,
      local: false,
    },
    {
      name: "missing environment",
      mode: "deployed",
      stage: "production",
      env: undefined,
      node: "production",
      login: true,
      staging: false,
      local: false,
    },
    {
      name: "missing all metadata",
      mode: undefined,
      stage: undefined,
      env: undefined,
      node: undefined,
      login: true,
      staging: false,
      local: false,
    },
    {
      name: "metadata without identity",
      mode: undefined,
      stage: "production",
      env: "stage",
      node: "development",
      login: true,
      staging: false,
      local: false,
    },
    {
      name: "invalid identity",
      mode: "",
      stage: "production",
      env: "stage",
      node: "development",
      login: true,
      staging: false,
      local: false,
    },
  ])("$name", async ({ mode, stage, env, node, login, staging, local }) => {
    const values = {
      PF_RUNTIME_MODE: mode,
      PF_STAGE: stage,
      PF_ENV: env,
      NODE_ENV: node,
    }
    for (const key of keys) {
      const value = values[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    expect(
      await evaluate([loginPermit, productionForbid!, stagingPermit!]),
    ).toEqual({ login, administer: staging })
    expect((await evaluate([localPermit!])).administer).toBe(local)

    // A policy observes the documented fallback values and legacy NODE_ENV,
    // independent of the environment-specific grants above.
    const runtimeMode =
      mode === "local" || mode === "deployed" ? mode : "unknown"
    const contextPermit = `permit (principal, action, resource) when {
      context.runtimeMode == ${JSON.stringify(runtimeMode)} &&
      context.stage == ${JSON.stringify(stage ?? "")} &&
      context.environment == ${JSON.stringify(env ?? "")} &&
      context.nodeEnv == ${JSON.stringify(node ?? "development")}
    };`
    expect(await evaluate([contextPermit])).toEqual({
      login: true,
      administer: true,
    })
  })

  it("does not narrow another permit and never overrides a forbid", async () => {
    process.env["PF_RUNTIME_MODE"] = "deployed"
    process.env["PF_STAGE"] = "production"
    process.env["PF_ENV"] = "prod"
    const broadPermit = `permit (principal, action, resource);`
    expect((await evaluate([broadPermit, localPermit!])).administer).toBe(true)
    expect((await evaluate([broadPermit, productionForbid!])).login).toBe(false)
  })
})
