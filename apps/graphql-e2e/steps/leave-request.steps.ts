import assert from "node:assert"
import { Given, Then, When } from "@cucumber/cucumber"
import type { TestWorld } from "../support/world"

Given(
  "I wait {int} seconds",
  { timeout: 60000 },
  async function (this: TestWorld, seconds: number) {
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
  },
)

When(
  "I start a time off request for dates {string}",
  { timeout: 30000 },
  async function (this: TestWorld, dates: string) {
    const mutation = `
      mutation StartTimeOffRequest($input: HrTimeOffRequestSubmitTimeOffRequest!) {
        startHrTimeOffRequest(input: $input) {
          executionId
          processId
          processPath
          timestamp
        }
      }
    `

    const result = await this.executeGraphQL<{
      startHrTimeOffRequest: {
        executionId: string
        processId: string
        processPath: string
        timestamp: string
      }
    }>(mutation, {
      input: { dates },
    })

    this.startProcessResult = result.startHrTimeOffRequest

    // Verify process started successfully
    assert.ok(this.startProcessResult, "Start process result should be defined")
    assert.ok(
      this.startProcessResult.executionId,
      "Execution ID should be defined",
    )
    assert.ok(this.startProcessResult.processId, "Process ID should be defined")
  },
)

When(
  "I complete the first todo with time off approval",
  { timeout: 30000 },
  async function (this: TestWorld) {
    assert.ok(this.todoDocuments, "No todos available")
    assert.ok(this.todoDocuments.length > 0, "No todos to complete")

    // biome-ignore lint/style/noNonNullAssertion: length check above guarantees this exists
    const todo = this.todoDocuments[0]!

    const mutation = `
      mutation ApproveTimeOff($todoId: ID!, $input: HrTimeOffRequestApproveTimeOff!) {
        completeHrTimeOffRequestApproveTimeOff(todoId: $todoId, input: $input) {
          executionId
          stepPath
          timestamp
        }
      }
    `

    const result = await this.executeGraphQL<{
      completeHrTimeOffRequestApproveTimeOff: {
        executionId: string
        stepPath: string
        timestamp: string
      }
    }>(mutation, {
      todoId: todo.id,
      input: { approved: true },
    })

    this.completeStepResult = result.completeHrTimeOffRequestApproveTimeOff
  },
)

When(
  "I complete the first todo as notification acknowledgment",
  { timeout: 30000 },
  async function (this: TestWorld) {
    assert.ok(this.todoDocuments, "No todos available")
    assert.ok(this.todoDocuments.length > 0, "No todos to complete")

    // biome-ignore lint/style/noNonNullAssertion: length check above guarantees this exists
    const todo = this.todoDocuments[0]!

    // The notify employee step has no input - just needs to be completed
    const mutation = `
      mutation NotifyEmployee($todoId: ID!) {
        completeHrTimeOffRequestNotifyEmployee(todoId: $todoId) {
          executionId
          stepPath
          timestamp
        }
      }
    `

    const result = await this.executeGraphQL<{
      completeHrTimeOffRequestNotifyEmployee: {
        executionId: string
        stepPath: string
        timestamp: string
      }
    }>(mutation, {
      todoId: todo.id,
    })

    this.completeStepResult = result.completeHrTimeOffRequestNotifyEmployee
  },
)

/**
 * Verify that the mutation timestamp is close to the current time.
 * This catches bugs where _requestTime is captured at server startup instead of per-request.
 * Such a bug caused scheduled flows to execute immediately instead of waiting.
 */
Then(
  "the mutation timestamp should be within {int} seconds of now",
  async function (this: TestWorld, maxDriftSeconds: number) {
    assert.ok(
      this.startProcessResult?.timestamp,
      "No start process result with timestamp",
    )

    const mutationTime = new Date(this.startProcessResult.timestamp).getTime()
    const now = Date.now()
    const driftMs = Math.abs(now - mutationTime)
    const driftSeconds = driftMs / 1000

    assert.ok(
      driftSeconds <= maxDriftSeconds,
      `Mutation timestamp drift too large: ${driftSeconds.toFixed(1)}s (max ${maxDriftSeconds}s). ` +
        `This may indicate _requestTime is captured at server startup instead of per-request. ` +
        `Mutation time: ${this.startProcessResult.timestamp}, Now: ${new Date().toISOString()}`,
    )
  },
)
