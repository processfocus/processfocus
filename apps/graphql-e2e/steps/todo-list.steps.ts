import assert from "node:assert"
import { Then, When } from "@cucumber/cucumber"
import type { TestWorld, TodoListPageResult } from "../support/world"

const TODO_LIST_QUERY = `
  query Todos($page: Int!, $limit: Int!, $processPath: String, $status: String) {
    todos(page: $page, limit: $limit, processPath: $processPath, status: $status) {
      nodes {
        id
        processExecutionId
        processName
        stepName
        stepPath
        role
        status
        priority
        assignedAt
        dueAt
        description
        summary { label value }
      }
      page
      limit
      hasNextPage
    }
  }
`

const queryTodoList = async (
  world: TestWorld,
  variables: {
    readonly page: number
    readonly limit: number
    readonly processPath?: string
    readonly status?: string
  },
) => {
  const result = await world.executeGraphQL<{ todos: TodoListPageResult }>(
    TODO_LIST_QUERY,
    variables,
  )
  world.todoListPages.push(result.todos)
}

When(
  "I query Todo list page {int} with limit {int}",
  async function (this: TestWorld, page: number, limit: number) {
    await queryTodoList(this, { page, limit })
  },
)

When(
  "I query Todo list page {int} with limit {int} for process {string} and status {string}",
  async function (
    this: TestWorld,
    page: number,
    limit: number,
    processPath: string,
    status: string,
  ) {
    await queryTodoList(this, { page, limit, processPath, status })
  },
)

Then(
  "the latest Todo list page has {int} node(s) and hasNextPage is {word}",
  function (this: TestWorld, count: number, hasNextPage: string) {
    const latest = this.todoListPages.at(-1)
    assert.ok(latest, "No Todo list page available")
    assert.strictEqual(latest.nodes.length, count)
    assert.ok(
      hasNextPage === "true" || hasNextPage === "false",
      `Expected true or false, received ${hasNextPage}`,
    )
    assert.strictEqual(latest.hasNextPage, hasNextPage === "true")
  },
)

Then(
  "the latest Todo list node has only the public Todo keys",
  function (this: TestWorld) {
    const node = this.todoListPages.at(-1)?.nodes[0]
    assert.ok(node, "No Todo list node available")
    assert.deepStrictEqual(Object.keys(node).toSorted(), [
      "assignedAt",
      "description",
      "dueAt",
      "id",
      "priority",
      "processExecutionId",
      "processName",
      "role",
      "status",
      "stepName",
      "stepPath",
      "summary",
    ])
  },
)

Then(
  "the first nodes of the last two Todo list pages are different",
  function (this: TestWorld) {
    const previous = this.todoListPages.at(-2)?.nodes[0]
    const latest = this.todoListPages.at(-1)?.nodes[0]
    assert.ok(previous, "Previous Todo list page has no first node")
    assert.ok(latest, "Latest Todo list page has no first node")
    assert.notStrictEqual(previous.id, latest.id)
  },
)
