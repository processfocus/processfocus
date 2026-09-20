import assert from "node:assert"
import { Then, When } from "@cucumber/cucumber"
import type { ProcessListPageResult, TestWorld } from "../support/world"

const PROCESS_LIST_QUERY = `
  query Processes($page: Int!, $limit: Int!, $processPath: String, $status: String) {
    processes(page: $page, limit: $limit, processPath: $processPath, status: $status) {
      nodes {
        id
        path
        name
        category
        purpose
        startStepPath
        activeInstances
      }
      page
      limit
      hasNextPage
    }
  }
`

const queryProcessList = async (
  world: TestWorld,
  variables: {
    readonly page: number
    readonly limit: number
    readonly processPath?: string
    readonly status?: string
  },
) => {
  const result = await world.executeGraphQL<{
    processes: ProcessListPageResult
  }>(PROCESS_LIST_QUERY, variables)
  world.processListPages.push(result.processes)
}

When(
  "I query Process list page {int} with limit {int}",
  async function (this: TestWorld, page: number, limit: number) {
    await queryProcessList(this, { page, limit })
  },
)

When(
  "I query Process list page {int} with limit {int} for process {string} and status {string}",
  async function (
    this: TestWorld,
    page: number,
    limit: number,
    processPath: string,
    status: string,
  ) {
    await queryProcessList(this, { page, limit, processPath, status })
  },
)

Then(
  "the latest Process list page has {int} node(s) and hasNextPage is {word}",
  function (this: TestWorld, count: number, hasNextPage: string) {
    const latest = this.processListPages.at(-1)
    assert.ok(latest, "No Process list page available")
    assert.strictEqual(latest.nodes.length, count)
    assert.ok(
      hasNextPage === "true" || hasNextPage === "false",
      `Expected true or false, received ${hasNextPage}`,
    )
    assert.strictEqual(latest.hasNextPage, hasNextPage === "true")
  },
)

Then(
  "the latest Process list node has only the public Process keys",
  function (this: TestWorld) {
    const node = this.processListPages.at(-1)?.nodes[0]
    assert.ok(node, "No Process list node available")
    assert.deepStrictEqual(Object.keys(node).toSorted(), [
      "activeInstances",
      "category",
      "id",
      "name",
      "path",
      "purpose",
      "startStepPath",
    ])
  },
)

Then(
  "the latest Process list includes process {string}",
  function (this: TestWorld, processPath: string) {
    const latest = this.processListPages.at(-1)
    assert.ok(latest, "No Process list page available")
    assert.ok(
      latest.nodes.some((node) => node.path === processPath),
      `Expected Process list to include ${processPath}`,
    )
  },
)

Then(
  "the latest Process list excludes process {string}",
  function (this: TestWorld, processPath: string) {
    const latest = this.processListPages.at(-1)
    assert.ok(latest, "No Process list page available")
    assert.ok(
      latest.nodes.every((node) => node.path !== processPath),
      `Expected Process list to exclude ${processPath}`,
    )
  },
)
