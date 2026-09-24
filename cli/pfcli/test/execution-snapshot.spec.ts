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
  "reads the full terminal snapshot in one request with %i newer executions",
  async (historyCount) => {
    const rows = new Map([
      [terminal.id, terminal],
      ...Array.from(
        { length: historyCount },
        (_, i): [string, ExecutionSnapshot] => [
          `newer-${i}`,
          { ...terminal, id: `newer-${i}`, finishedAt: "2026-01-01T00:00:00Z" },
        ],
      ),
    ])
    const requests: string[] = []
    globalThis.fetch = Object.assign(
      async (_input: string | URL | Request, init?: RequestInit) => {
        const { query, variables } = JSON.parse(String(init?.body))
        requests.push(query)
        expect(query).toContain("execution(id: $id)")
        expect(query).not.toContain("executions(")
        expect(query).not.toContain("pullExecution")
        expect(variables).toEqual({ id: terminal.id })
        return Response.json({
          data: { execution: rows.get(variables.id) ?? null },
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
    expect(snapshot).toEqual(terminal)
    expect(requests).toHaveLength(1)
  },
)

it("retains abandonment details and failed-step evidence", async () => {
  const abandoned: ExecutionSnapshot = {
    ...terminal,
    status: "Abandoned",
    abandonedReason: "Operator cancelled",
  }
  globalThis.fetch = Object.assign(
    async () => Response.json({ data: { execution: abandoned } }),
    { preconnect: originalFetch.preconnect },
  )
  const snapshot = await Effect.runPromise(
    fetchExecutionSnapshot(
      "https://backend.test/graphql",
      "test-token",
      terminal.id,
    ),
  )
  expect(snapshot).toEqual(abandoned)
})

it.each([
  {
    response: { data: { execution: null } },
    error: "not found or is not accessible",
  },
  {
    response: {
      errors: [{ message: 'Cannot query field "execution" on type "Query".' }],
    },
    error: 'Cannot query field "execution"',
  },
  { response: { errors: [{ message: "Read failed" }] }, error: "Read failed" },
])("reports $error without scanning history", async ({ response, error }) => {
  let requests = 0
  globalThis.fetch = Object.assign(
    async (_input: string | URL | Request, init?: RequestInit) => {
      requests++
      const { query } = JSON.parse(String(init?.body))
      expect(query).toContain("execution(id: $id)")
      expect(query).not.toContain("executions(")
      expect(query).not.toContain("pullExecution")
      return Response.json(response)
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
  ).rejects.toThrow(error)
  expect(requests).toBe(1)
})
