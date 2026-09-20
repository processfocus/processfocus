import assert from "node:assert"
import { Then, When } from "@cucumber/cucumber"
import type { TestWorld } from "../support/world"

/**
 * Execution-related step definitions for testing pullExecution queries.
 */

interface ExecutionStep {
  id: string
  name: string
  path: string
  status: string
}

interface Execution {
  id: string
  processName: string
  processPath: string
  status: string
  steps: ExecutionStep[]
}

interface PullExecutionResult {
  pullExecution: {
    documents: Execution[]
  }
}

// Store executions in world for later assertions
declare module "../support/world" {
  interface TestWorld {
    executionDocuments: Execution[] | undefined
  }
}

When(
  "I pull executions with limit {int}",
  async function (this: TestWorld, limit: number) {
    const query = `
      query PullExecution($limit: Int!) {
        pullExecution(limit: $limit) {
          documents {
            id
            processName
            processPath
            status
            steps {
              id
              name
              path
              status
            }
          }
        }
      }
    `

    const result = await this.executeGraphQL<PullExecutionResult>(query, {
      limit,
    })

    this.executionDocuments = result.pullExecution.documents
  },
)

Then(
  "I should have at least {int} execution(s)",
  function (this: TestWorld, count: number) {
    assert.ok(this.executionDocuments, "No executions pulled")
    assert.ok(
      this.executionDocuments.length >= count,
      `Expected at least ${count} execution(s), got ${this.executionDocuments.length}`,
    )
  },
)

Then("execution steps should have no duplicates", function (this: TestWorld) {
  assert.ok(this.executionDocuments, "No executions pulled")

  for (const execution of this.executionDocuments) {
    const stepPaths = execution.steps.map((s) => s.path)
    const uniquePaths = new Set(stepPaths)

    if (stepPaths.length !== uniquePaths.size) {
      // Find duplicates for error message
      const counts = new Map<string, number>()
      for (const path of stepPaths) {
        counts.set(path, (counts.get(path) ?? 0) + 1)
      }
      const duplicates = [...counts.entries()]
        .filter(([, count]) => count > 1)
        .map(([path, count]) => `${path} (${count}x)`)

      assert.fail(
        `Execution ${execution.id} has duplicate steps: ${duplicates.join(", ")}`,
      )
    }
  }
})

Then(
  "the step {string} should appear exactly {int} time(s)",
  function (this: TestWorld, stepName: string, expectedCount: number) {
    assert.ok(this.executionDocuments, "No executions pulled")
    assert.ok(
      this.startProcessResult?.executionId,
      "No process started in this scenario - cannot check step count without execution context",
    )

    // Only count in the current execution (identified by startProcessResult)
    // This ensures test isolation - we don't count steps from other scenarios
    const currentExecutionId = this.startProcessResult.executionId
    const executionsToCheck = this.executionDocuments.filter(
      (e) => e.id === currentExecutionId,
    )

    let totalCount = 0
    for (const execution of executionsToCheck) {
      const matchingSteps = execution.steps.filter((s) => s.name === stepName)
      totalCount += matchingSteps.length
    }

    assert.strictEqual(
      totalCount,
      expectedCount,
      `Expected step "${stepName}" to appear ${expectedCount} time(s), but found ${totalCount}`,
    )
  },
)
