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

const EXECUTION_FIELDS = `
  id status failureReason abandonedReason finishedAt
  canAbandonExecution canRestartExecution
  steps { name path status failureReason }
`

interface ExecutionDocument {
  readonly id: string
  readonly status: string
  readonly failureReason: string | null
  readonly abandonedReason: string | null
  readonly finishedAt: string | null
  readonly canAbandonExecution: boolean
  readonly canRestartExecution: boolean
  readonly steps: readonly {
    readonly name: string
    readonly path: string
    readonly status: string
    readonly failureReason: string | null
  }[]
}

Then(
  "I can read the started Execution with its persisted details and capabilities",
  async function (this: TestWorld) {
    assert.ok(this.startProcessResult)
    const id = this.startProcessResult.executionId
    const result = await this.executeGraphQL<{
      execution: ExecutionDocument | null
      pullExecution: { documents: ExecutionDocument[] }
    }>(
      `query Execution($id: ID!) {
      execution(id: $id) { ${EXECUTION_FIELDS} }
      pullExecution(limit: 100) { documents { ${EXECUTION_FIELDS} } }
    }`,
      { id },
    )
    assert.ok(result.execution)
    assert.strictEqual(result.execution.id, id)
    assert.strictEqual(result.execution.status, "Running")
    // Local e2e imports a disposable organisation that permits this provider
    // user to abandon purchase-request steps. Deployed demo policy does not,
    // so false is the authorized projection there.
    const canAbandonExecution = process.env["BASE_URL"] === undefined
    assert.strictEqual(
      result.execution.canAbandonExecution,
      canAbandonExecution,
    )
    assert.strictEqual(result.execution.canRestartExecution, false)
    assert.strictEqual(result.execution.failureReason, null)
    assert.strictEqual(result.execution.abandonedReason, null)
    assert.strictEqual(result.execution.finishedAt, null)
    assert.ok(
      result.execution.steps.some((step) => step.status === "Completed"),
    )
    assert.ok(result.execution.steps.some((step) => step.status === "Waiting"))
    assert.deepStrictEqual(
      result.execution,
      result.pullExecution.documents.find((doc) => doc.id === id),
    )
  },
)

Then(
  "the started Execution is not accessible by id",
  async function (this: TestWorld) {
    assert.ok(this.startProcessResult)
    const result = await this.executeGraphQL<{
      execution: ExecutionDocument | null
    }>(
      `query Execution($id: ID!) { execution(id: $id) { ${EXECUTION_FIELDS} } }`,
      { id: this.startProcessResult.executionId },
    )
    assert.strictEqual(result.execution, null)
  },
)

Then("an unknown Execution id returns null", async function (this: TestWorld) {
  const result = await this.executeGraphQL<{
    execution: ExecutionDocument | null
  }>(`query { execution(id: "unknown-execution") { ${EXECUTION_FIELDS} } }`)
  assert.strictEqual(result.execution, null)
})

Then(
  "the single Execution query requires an id and the list query has no id argument",
  async function (this: TestWorld) {
    const result = await this.executeGraphQL<{
      __type: {
        fields: {
          name: string
          type: { kind: string; name: string | null }
          args: {
            name: string
            type: { kind: string; ofType: { name: string } | null }
          }[]
        }[]
      }
    }>(`query {
      __type(name: "Query") {
        fields { name type { kind name } args { name type { kind ofType { name } } } }
      }
    }`)
    const execution = result.__type.fields.find(
      (field) => field.name === "execution",
    )
    assert.ok(execution)
    assert.deepStrictEqual(execution.type, {
      kind: "OBJECT",
      name: "Execution",
    })
    assert.deepStrictEqual(execution.args, [
      { name: "id", type: { kind: "NON_NULL", ofType: { name: "ID" } } },
    ])
    const executions = result.__type.fields.find(
      (field) => field.name === "executions",
    )
    assert.ok(executions)
    assert.deepStrictEqual(executions.args.map((arg) => arg.name).toSorted(), [
      "limit",
      "page",
      "processPath",
      "status",
    ])
  },
)
