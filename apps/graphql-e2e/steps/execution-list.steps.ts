import assert from "node:assert"
import { Then, When } from "@cucumber/cucumber"
import type { ExecutionListPageResult, TestWorld } from "../support/world"

const EXECUTION_LIST_QUERY = `
  query Executions($page: Int!, $limit: Int!, $processPath: String, $status: String) {
    executions(page: $page, limit: $limit, processPath: $processPath, status: $status) {
      nodes {
        id
        processPath
        processName
        status
        startedAt
        finishedAt
        completedSteps
        totalSteps
        failureReason
      }
      page
      limit
      hasNextPage
    }
  }
`

const queryExecutionList = async (
  world: TestWorld,
  variables: {
    readonly page: number
    readonly limit: number
    readonly processPath?: string
    readonly status?: string
  },
) => {
  const result = await world.executeGraphQL<{
    executions: ExecutionListPageResult
  }>(EXECUTION_LIST_QUERY, variables)
  world.executionListPages.push(result.executions)
}

When(
  "I query Execution list page {int} with limit {int}",
  async function (this: TestWorld, page: number, limit: number) {
    await queryExecutionList(this, { page, limit })
  },
)

When(
  "I query Execution list page {int} with limit {int} for process {string} and status {string}",
  async function (
    this: TestWorld,
    page: number,
    limit: number,
    processPath: string,
    status: string,
  ) {
    await queryExecutionList(this, { page, limit, processPath, status })
  },
)

Then(
  "the latest Execution list page has {int} node(s) and hasNextPage is {word}",
  function (this: TestWorld, count: number, hasNextPage: string) {
    const latest = this.executionListPages.at(-1)
    assert.ok(latest, "No Execution list page available")
    assert.strictEqual(latest.nodes.length, count)
    assert.ok(
      hasNextPage === "true" || hasNextPage === "false",
      `Expected true or false, received ${hasNextPage}`,
    )
    assert.strictEqual(latest.hasNextPage, hasNextPage === "true")
  },
)

Then(
  "the latest Execution list node has only the public Execution keys",
  function (this: TestWorld) {
    const node = this.executionListPages.at(-1)?.nodes[0]
    assert.ok(node, "No Execution list node available")
    assert.deepStrictEqual(Object.keys(node).toSorted(), [
      "completedSteps",
      "failureReason",
      "finishedAt",
      "id",
      "processName",
      "processPath",
      "startedAt",
      "status",
      "totalSteps",
    ])
  },
)

Then(
  "the first nodes of the last two Execution list pages are different",
  function (this: TestWorld) {
    const previous = this.executionListPages.at(-2)?.nodes[0]
    const latest = this.executionListPages.at(-1)?.nodes[0]
    assert.ok(previous, "Previous Execution list page has no first node")
    assert.ok(latest, "Latest Execution list page has no first node")
    assert.notStrictEqual(previous.id, latest.id)
  },
)
