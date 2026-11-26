import { readFileSync } from "node:fs"
import * as cedar from "@cedar-policy/cedar-wasm/nodejs"
import { describe, expect, test } from "vitest"
import { mock } from "bun:test"

mock.module("server-only", () => ({}))
// Match the real Node WASM loader used by the hosted server; Bun's test runner
// does not implement the ESM WASM import used by the Next bundler.
mock.module("@cedar-policy/cedar-wasm", () => cedar)

const { evaluateWithArtifacts } = await import(
  "../app/(protected)/settings/cedar/cedar-authorize"
)
const schema = readFileSync(
  new URL(
    "../../../packages/auth-policy/cedar/schema.cedarschema",
    import.meta.url,
  ),
  "utf8",
)
const input = {
  principal: { type: "PF::ProviderUser", id: "cedar-test@example.com" },
  roles: ["/Administrator"],
  orgUnitId: "/",
  action: "login",
  resource: { type: "PF::Application", id: "default" },
  processPath: null,
  entity: null,
  attrValues: {},
}

describe("Cedar artifact reuse", () => {
  test("simulates Step completion with independent public-link and assignment context", () => {
    const policies = readFileSync(
      new URL(
        "../../../packages/auth-policy/cedar/policies.cedar",
        import.meta.url,
      ),
      "utf8",
    )
    const stepInput = {
      ...input,
      action: "complete",
      resource: { type: "PF::Step", id: "/work/Approve" },
      processPath: "/work",
      entity: {
        typeName: "PF::Step",
        memberOf: ["PF::Process"],
        attributes: [
          { control: "boolean", name: "startsProcess", required: true },
          { control: "boolean", name: "embedded", required: true },
          { control: "role", name: "role", required: false },
        ],
      },
      attrValues: { role: "/Administrator" },
    } satisfies import("../app/(protected)/settings/cedar/cedar-types").AuthorizationEvalInput
    const evaluate = (
      request: typeof stepInput & {
        completionContext?: { todoId: string; assignedTo?: string }
      },
    ) => evaluateWithArtifacts(policies, schema, request, false)
    const linked = {
      ...stepInput,
      principal: { type: "PF::PublicLink", id: "todo-1" },
    }
    expect(
      evaluate({ ...linked, completionContext: { todoId: "todo-1" } }).decision,
    ).toBe("allow")
    expect(
      evaluate({ ...linked, completionContext: { todoId: "todo-2" } }).decision,
    ).toBe("deny")
    expect(evaluate(linked).decision).toBe("deny")
    const assigned = evaluate({
      ...stepInput,
      completionContext: { todoId: "todo-1", assignedTo: input.principal.id },
    })
    expect(assigned.decision).toBe("allow")
    expect(assigned.request.context.assignedTo).toBe(input.principal.id)
    expect(
      evaluate({
        ...stepInput,
        completionContext: {
          todoId: "todo-1",
          assignedTo: "other@example.com",
        },
      }).decision,
    ).toBe("deny")
  })

  test("evaluates deployment metadata and reports the context used by the explorer", () => {
    const keys = ["PF_RUNTIME_MODE", "PF_STAGE", "PF_ENV"] as const
    const original = keys.map((key) => process.env[key])
    const policy = `permit(principal, action, resource) when {
      context.runtimeMode == "deployed" && context.stage == "production" &&
      context.environment == "stage"
    };`
    try {
      process.env["PF_RUNTIME_MODE"] = "deployed"
      process.env["PF_STAGE"] = "production"
      process.env["PF_ENV"] = "stage"
      const deployed = evaluateWithArtifacts(policy, schema, input, false)
      expect(deployed.decision).toBe("allow")
      expect(deployed.request.context).toMatchObject({
        runtimeMode: "deployed",
        stage: "production",
        environment: "stage",
      })
      process.env["PF_RUNTIME_MODE"] = "local"
      expect(evaluateWithArtifacts(policy, schema, input, false).decision).toBe(
        "deny",
      )
      for (const key of keys) delete process.env[key]
      const missing = evaluateWithArtifacts(policy, schema, input, false)
      expect(missing.decision).toBe("deny")
      expect(missing.errors).toEqual([])
      expect(missing.request.context).toMatchObject({
        runtimeMode: "unknown",
        stage: "",
        environment: "",
      })
    } finally {
      keys.forEach((key, index) => {
        const value = original[index]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      })
    }
  })

  test("uses current policies and request entities, rejects invalid replacements, and recovers", () => {
    const permit =
      'permit(principal in PF::Role::"/Administrator", action == PF::Action::"login", resource);'
    const forbid = `${permit}\nforbid(principal, action, resource);`
    const evaluate = (
      policies: string,
      currentSchema = schema,
      request = input,
    ) => evaluateWithArtifacts(policies, currentSchema, request, true)

    expect(evaluate(permit).decision).toBe("allow")
    expect(evaluate(permit, schema, { ...input, roles: [] }).decision).toBe(
      "deny",
    )
    expect(evaluate(forbid).decision).toBe("deny")
    expect(evaluate("invalid policy").decision).toBe("error")
    expect(evaluate(permit, "invalid schema").decision).toBe("error")
    const restored = evaluate(permit)
    expect(restored.decision).toBe("allow")
    expect(restored.policyTexts).toEqual([permit])
  })
})
