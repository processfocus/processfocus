import assert from "node:assert"
import { Then, When } from "@cucumber/cucumber"
import type { TestWorld } from "../support/world"

When(
  "I query for processes with limit {int}",
  async function (this: TestWorld, limit: number) {
    const client = this.getClient()
    const result = await client.query({
      pullProcess: {
        __args: { checkpoint: null, limit },
        documents: {
          id: true,
        },
      },
    })
    this.processDocuments = result.pullProcess.documents
  },
)

Then("I should receive zero processes", function (this: TestWorld) {
  assert.ok(this.processDocuments, "Query result should be defined")
  assert.ok(
    Array.isArray(this.processDocuments),
    "Documents should be an array",
  )
  assert.strictEqual(
    this.processDocuments.length,
    0,
    `Expected zero processes but got ${this.processDocuments.length}`,
  )
})

Then("I should receive at least one process", function (this: TestWorld) {
  assert.ok(this.processDocuments, "Query result should be defined")
  assert.ok(
    Array.isArray(this.processDocuments),
    "Documents should be an array",
  )
  assert.ok(
    this.processDocuments.length > 0,
    "Expected at least one process but got none",
  )
})
