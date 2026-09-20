import assert from "node:assert"
import { Given, Then, When } from "@cucumber/cucumber"
import { runAuthenticateAsFrontend } from "../support/auth-helpers"
import type { TestWorld } from "../support/world"

Given(
  "I am authenticated as the frontend client",
  { timeout: 10_000 },
  async function (this: TestWorld) {
    const result = await runAuthenticateAsFrontend()
    if (!result.access_token) {
      throw new Error(`Authentication failed: ${result.error}`)
    }
    this.accessToken = result.access_token
  },
)

When("I query cedar policies", async function (this: TestWorld) {
  const client = this.getClient()
  const result = await client.query({
    cedarPolicies: {
      policies: true,
      schema: true,
    },
  })

  this.cedarPoliciesResult = result.cedarPolicies
})

When(
  "I attempt to query cedar policies",
  { timeout: 10_000 },
  async function (this: TestWorld) {
    const client = this.getClient()
    try {
      const result = await client.query({
        cedarPolicies: {
          policies: true,
          schema: true,
        },
      })
      this.cedarPoliciesResult = result.cedarPolicies
      this.graphqlError = undefined
    } catch (error) {
      if (error instanceof Error) {
        this.graphqlError = error
        return
      }
      throw error
    }
  },
)

Then("cedar policies should be returned", function (this: TestWorld) {
  const body = this.cedarPoliciesResult
  assert.ok(body, "Cedar policies query result should be defined")
  assert.ok(
    Array.isArray(body.policies) && body.policies.length > 0,
    "Cedar policies should contain at least one policy",
  )
  assert.ok(
    typeof body.schema === "string" && body.schema.length > 0,
    "Cedar policies should include a schema",
  )
})
