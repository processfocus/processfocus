import assert from "node:assert"
import { Then, When } from "@cucumber/cucumber"
import type { TestWorld } from "../support/world"

When("I query the org", async function (this: TestWorld) {
  const client = this.getClient()
  const result = await client.query({
    org: {
      name: true,
      acronym: true,
    },
  })
  this.orgResult = result.org ?? undefined
})

When("I query the org levels", async function (this: TestWorld) {
  const client = this.getClient()
  const result = await client.query({
    orgLevels: {
      level: true,
      maxDepth: true,
    },
  })
  this.orgLevelsResult = result.orgLevels ?? undefined
})

When(
  "I attempt to query the org",
  { timeout: 10_000 },
  async function (this: TestWorld) {
    const client = this.getClient()
    try {
      const result = await client.query({
        org: {
          name: true,
          acronym: true,
        },
      })
      this.orgResult = result.org ?? undefined
    } catch (error) {
      if (error instanceof Error) {
        this.graphqlError = error
        return
      }
      throw error
    }
  },
)

Then(
  "the org name should be {string}",
  function (this: TestWorld, expectedName: string) {
    assert.ok(this.orgResult, "Org query result should be defined")
    assert.strictEqual(
      this.orgResult.name,
      expectedName,
      `Expected org name "${expectedName}" but got "${this.orgResult.name}"`,
    )
  },
)

Then(
  "the org acronym should be {string}",
  function (this: TestWorld, expectedAcronym: string) {
    assert.ok(this.orgResult, "Org query result should be defined")
    assert.strictEqual(
      this.orgResult.acronym,
      expectedAcronym,
      `Expected org acronym "${expectedAcronym}" but got "${this.orgResult.acronym}"`,
    )
  },
)

Then(
  "the org levels should include {word} at maxDepth {int}",
  function (this: TestWorld, level: string, expectedMaxDepth: number) {
    assert.ok(this.orgLevelsResult, "Org levels query result should be defined")
    // The nested HR automation fixture adds the team level at depth 3.
    assert.strictEqual(
      this.orgLevelsResult.length,
      3,
      `Expected exactly three org levels for demo org, got ${this.orgLevelsResult.length}: ${this.orgLevelsResult
        .map((item) => `${item.level}@${item.maxDepth}`)
        .join(", ")}`,
    )
    const entry = this.orgLevelsResult.find((item) => item.level === level)
    assert.ok(
      entry,
      `Expected level "${level}" among: ${this.orgLevelsResult
        .map((item) => item.level)
        .join(", ")}`,
    )
    assert.strictEqual(
      entry.maxDepth,
      expectedMaxDepth,
      `Expected ${level} maxDepth ${expectedMaxDepth}, got ${entry.maxDepth}`,
    )
  },
)

Then(
  "the org levels should be ordered by maxDepth ascending",
  function (this: TestWorld) {
    assert.ok(this.orgLevelsResult, "Org levels query result should be defined")
    const levels = this.orgLevelsResult
    for (let index = 1; index < levels.length; index++) {
      const previousLevel = levels[index - 1]
      const currentLevel = levels[index]
      if (previousLevel === undefined || currentLevel === undefined) {
        assert.fail(`Missing org level around index ${index}`)
      }
      assert.ok(
        previousLevel.maxDepth <= currentLevel.maxDepth,
        `Expected maxDepth non-decreasing at index ${index}: ${previousLevel.maxDepth} then ${currentLevel.maxDepth}`,
      )
    }
  },
)
