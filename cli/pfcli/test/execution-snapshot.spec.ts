import { Effect } from "effect"
import { fetchExecutionSnapshot } from "../src/utils/execution-snapshot"
import type { ExecutionSnapshot } from "../src/utils/execution-subscription"
import { useSerializedTestState } from "./test-helpers"
import { afterEach, expect, it } from "bun:test"

useSerializedTestState()

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

const startedAt = "2020-01-01T00:00:00Z"
const startedAtMillis = Date.parse(startedAt)
const terminal: ExecutionSnapshot = {
  id: "deployment",
  status: "Failed",
  failureReason: "Deployment failed",
  abandonedReason: null,
  finishedAt: startedAt,
  steps: [
    {
      name: "Execute deployment",
      path: "/operations/deploy/Execute deployment",
      status: "Failed",
      failureReason:
        "Insufficient project credit. Remaining balance: USD -0.001. An operator must add credit before deploying.",
    },
  ],
}

it.each([0, 10_000])(
  "reads the full terminal snapshot in two requests with %i older executions",
  async (historyCount) => {
    const history = Array.from({ length: historyCount }, (_, i) => ({
      ...terminal,
      id: `old-${i}`,
      updatedAt: startedAtMillis - historyCount + i,
    }))
    // Same timestamp as createdAt: the lower checkpoint must include ties, and
    // must come from server data even when the client's clock is years ahead.
    const rows = [...history, { ...terminal, updatedAt: startedAtMillis }]
    const requests: string[] = []
    globalThis.fetch = Object.assign(
      async (_input: string | URL | Request, init?: RequestInit) => {
        const { query, variables } = JSON.parse(String(init?.body))
        if (query.includes("DeployExecutionLocation")) {
          requests.push("location")
          expect(variables.page).toBe(1)
          return Response.json({
            data: {
              executions: {
                nodes: [{ id: terminal.id, startedAt }],
                hasNextPage: historyCount >= 100,
              },
            },
          })
        }
        requests.push("snapshot")
        const checkpoint = variables.checkpoint
        const documents = rows
          .filter(
            (row) =>
              checkpoint === null ||
              row.updatedAt > checkpoint.updatedAt ||
              (row.updatedAt === checkpoint.updatedAt &&
                row.id > checkpoint.id),
          )
          .slice(0, 100)
        const last = documents.at(-1)
        return Response.json({
          data: {
            pullExecution: {
              documents,
              checkpoint: last
                ? { id: last.id, updatedAt: last.updatedAt }
                : null,
            },
          },
        })
      },
      { preconnect: originalFetch.preconnect },
    )

    const snapshot = await Effect.runPromise(
      fetchExecutionSnapshot(
        "https://backend.test/graphql",
        "test-token",
        terminal.id,
      ),
    )
    expect(snapshot).toMatchObject(terminal)
    expect(requests).toEqual(["location", "snapshot"])
  },
)

it("pages past newer executions and retains abandonment details from the full projection", async () => {
  const pages: number[] = []
  globalThis.fetch = Object.assign(
    async (_input: string | URL | Request, init?: RequestInit) => {
      const { query, variables } = JSON.parse(String(init?.body))
      if (query.includes("DeployExecutionLocation")) {
        pages.push(variables.page)
        return Response.json({
          data: {
            executions: {
              nodes: [
                {
                  id: variables.page === 1 ? "newer-execution" : terminal.id,
                  startedAt,
                },
              ],
              hasNextPage: variables.page === 1,
            },
          },
        })
      }
      expect(variables.checkpoint).toEqual({
        id: "",
        updatedAt: startedAtMillis,
      })
      return Response.json({
        data: {
          pullExecution: {
            documents: [
              {
                ...terminal,
                status: "Abandoned",
                failureReason: null,
                steps: [],
                abandonedReason: "Operator cancelled",
              },
            ],
            checkpoint: null,
          },
        },
      })
    },
    { preconnect: originalFetch.preconnect },
  )
  const snapshot = await Effect.runPromise(
    fetchExecutionSnapshot(
      "https://backend.test/graphql",
      "test-token",
      terminal.id,
    ),
  )
  expect(pages).toEqual([1, 2])
  expect(snapshot.status).toBe("Abandoned")
  expect(snapshot.abandonedReason).toBe("Operator cancelled")
})

it("reports an inaccessible execution without scanning historical replication pages", async () => {
  let requests = 0
  globalThis.fetch = Object.assign(
    async () => {
      requests++
      return Response.json({
        data: { executions: { nodes: [], hasNextPage: false } },
      })
    },
    { preconnect: originalFetch.preconnect },
  )
  await expect(
    Effect.runPromise(
      fetchExecutionSnapshot(
        "https://backend.test/graphql",
        "test-token",
        terminal.id,
      ),
    ),
  ).rejects.toThrow("not found or is not accessible")
  expect(requests).toBe(1)
})
