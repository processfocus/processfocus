import assert from "node:assert"
import { After, Given, Then, When } from "@cucumber/cucumber"
import { usesAppSyncEvents } from "@pf/frontend-endpoints"
import {
  runAuthenticateAsProviderUser,
  runAuthenticateWithRole,
} from "../support/auth-helpers"
import { WEBSOCKET_STEP_TIMEOUT_MS } from "../support/subscription-timeouts"
import type { TestWorld } from "../support/world"

// Clean up subscriptions after each scenario
// Use async with small delay to allow any pending WebSocket error events to settle
// before moving to next scenario (prevents unhandled rejections from async errors)
After(async function (this: TestWorld) {
  this.unsubscribe()
  this.unsubscribeAllUsers()
  // Brief delay to allow pending WebSocket errors to fire
  await new Promise((resolve) => setTimeout(resolve, 50))
})

When(
  "I start a purchase request process with amount {int}",
  async function (this: TestWorld, amount: number) {
    const mutation = `
      mutation StartPurchaseRequest($input: FinancePurchaseRequestSubmitRequest!) {
        startFinancePurchaseRequest(input: $input) {
          executionId
          processId
          processPath
          timestamp
        }
      }
    `

    const result = await this.executeGraphQL<{
      startFinancePurchaseRequest: {
        executionId: string
        processId: string
        processPath: string
        timestamp: string
      }
    }>(mutation, {
      input: { item: "Test Item", value: String(amount) },
    })

    this.startProcessResult = result.startFinancePurchaseRequest
  },
)

Given(
  "I subscribe to draft process execution updates",
  async function (this: TestWorld) {
    await this.subscribe(`
      subscription StreamDraftProcessExecution {
        streamDraftProcessExecution {
          documents {
            id
            name
            state
            deleted
          }
          checkpoint {
            id
            updatedAt
          }
        }
      }
    `)
  },
)

Given("I subscribe to todo updates", async function (this: TestWorld) {
  await this.subscribe(`
    subscription StreamTodo {
      streamTodo {
        documents {
          id
          stepPath
          status
          description
        }
        checkpoint {
          id
          updatedAt
        }
      }
    }
  `)
})

Given(
  "I wait {int} ms for the subscription to establish",
  { timeout: 30000 },
  async function (this: TestWorld, ms: number) {
    await new Promise((resolve) => setTimeout(resolve, ms))
  },
)

When(
  "I wait for {int} subscription events with timeout {int} ms",
  { timeout: 30000 },
  async function (this: TestWorld, count: number, timeoutMs: number) {
    await this.waitForEvents(count, timeoutMs)
  },
)

Then("the subscription should not have errors", function (this: TestWorld) {
  assert.strictEqual(
    this.subscriptionError,
    null,
    `Subscription error: ${this.subscriptionError?.message}`,
  )
})

Then(
  "the last subscription event should contain documents",
  function (this: TestWorld) {
    assert.ok(
      this.subscriptionEvents.length > 0,
      "No subscription events received",
    )
    const lastEvent = this.subscriptionEvents.at(-1)
    assert.ok(lastEvent?.data, "Last event has no data")

    // Check that at least one subscription field has documents
    const data = lastEvent.data as Record<
      string,
      { documents?: unknown[] } | undefined
    >
    const hasDocuments = Object.values(data).some(
      (field) => field && Array.isArray(field.documents),
    )
    assert.ok(hasDocuments, "Last event contains no documents array")
  },
)

Then("I unsubscribe", function (this: TestWorld) {
  this.unsubscribe()
})

// ============ Multi-User Websocket Step Definitions ============

Given(
  "{string} is authenticated with the {string} role",
  { timeout: 30000 },
  async function (this: TestWorld, name: string, role: string) {
    // Use two-step flow: requestRole mutation then authenticate with role scope
    const result = await runAuthenticateWithRole(role)
    if (!result.access_token) {
      throw new Error(`Authentication failed for "${name}": ${result.error}`)
    }
    this.setUserSession(name, result.access_token)
  },
)

Given(
  "{string} is authenticated as provider user {string}",
  { timeout: 30000 },
  async function (this: TestWorld, name: string, email: string) {
    // Use two-step flow: requestProviderUserPermissions mutation then authenticate with email scope
    // This gives each user a unique userId for separate subscription channels
    const result = await runAuthenticateAsProviderUser(email)
    if (!result.access_token) {
      throw new Error(
        `Authentication as provider user "${email}" failed for "${name}": ${result.error}`,
      )
    }
    this.setUserSession(name, result.access_token)
  },
)

Given(
  "{string} subscribes to todo updates",
  { timeout: 30000 },
  async function (this: TestWorld, name: string) {
    await this.subscribeUserToTodos(name)
  },
)

Given(
  "{string} subscribes to process updates",
  { timeout: 30000 },
  async function (this: TestWorld, name: string) {
    await this.subscribeUserToProcesses(name)
  },
)

Given(
  "{string} subscribes to execution updates",
  { timeout: 30000 },
  async function (this: TestWorld, name: string) {
    await this.subscribeUserToExecutions(name)
  },
)

Given("I switch to user {string}", function (this: TestWorld, name: string) {
  this.switchToUser(name)
})

Then(
  "{string} should see a todo for step {string}",
  { timeout: WEBSOCKET_STEP_TIMEOUT_MS },
  async function (this: TestWorld, name: string, stepName: string) {
    await this.waitForUserTodoStep(name, stepName)
  },
)

Then(
  "{string} should see a todo for step {string} with summary {string} containing {string}",
  { timeout: WEBSOCKET_STEP_TIMEOUT_MS },
  async function (
    this: TestWorld,
    name: string,
    stepName: string,
    label: string,
    expectedValue: string,
  ) {
    await this.waitForUserTodoWithSummary(name, stepName, label, expectedValue)
  },
)

Then(
  "{string} should see a todo for step {string} with summary {string} containing pattern",
  { timeout: WEBSOCKET_STEP_TIMEOUT_MS },
  async function (
    this: TestWorld,
    name: string,
    stepName: string,
    label: string,
  ) {
    await this.waitForUserTodoWithSummaryPattern(name, stepName, label)
  },
)

Then(
  "{string} should not see any todos",
  { timeout: 10_000 },
  async function (this: TestWorld, name: string) {
    await this.assertNoUserTodos(name)
  },
)

Then(
  /^"([^"]*)" should see a process update for "([^"]*)" with (\d+) active instances?$/,
  { timeout: WEBSOCKET_STEP_TIMEOUT_MS },
  async function (
    this: TestWorld,
    name: string,
    processName: string,
    expectedActiveInstances: string,
  ) {
    await this.waitForUserProcessUpdate(
      name,
      processName,
      parseInt(expectedActiveInstances, 10),
    )
  },
)

Then(
  "{string} should not see any process updates",
  { timeout: 10_000 },
  async function (this: TestWorld, name: string) {
    await this.assertNoUserProcessUpdates(name)
  },
)

Then(
  "{string} should see a new execution for {string}",
  { timeout: WEBSOCKET_STEP_TIMEOUT_MS },
  async function (this: TestWorld, name: string, processName: string) {
    await this.waitForUserNewExecution(name, processName)
  },
)

Given("I clear all subscription events", function (this: TestWorld) {
  this.clearAllUserEvents()
})

// ============ Cross-User Subscription Authorization Step Definitions ============

When(
  "{string} tries to subscribe to {string}'s {string} channel",
  { timeout: 30000 },
  async function (
    this: TestWorld,
    subscriberName: string,
    targetName: string,
    collection: string,
  ) {
    // This test only makes sense on AWS with AppSync Events
    // On local/graphql-ws, skip gracefully
    if (!usesAppSyncEvents()) {
      console.log(
        `[Skip] Cross-user subscription test skipped - not running against AppSync Events`,
      )
      this.crossUserSubscriptionError = null
      return
    }

    this.crossUserSubscriptionError = await this.trySubscribeToOtherUserChannel(
      subscriberName,
      collection,
      targetName,
    )
  },
)

Then(
  "{string}'s subscription should be rejected",
  function (this: TestWorld, name: string) {
    // On local/graphql-ws, skip the assertion
    if (!usesAppSyncEvents()) {
      console.log(
        `[Skip] Cross-user subscription rejection assertion skipped - not running against AppSync Events`,
      )
      return
    }

    assert.ok(
      this.crossUserSubscriptionError !== null,
      `Expected "${name}"'s subscription to be rejected, but it succeeded. ` +
        `Users should not be able to subscribe to other users' channels.`,
    )

    // Verify it's an authorization-related error
    const errorMessage = this.crossUserSubscriptionError.message.toLowerCase()
    const isAuthError =
      errorMessage.includes("unauthorized") ||
      errorMessage.includes("forbidden") ||
      errorMessage.includes("401") ||
      errorMessage.includes("403")

    assert.ok(
      isAuthError,
      `Expected authorization error, but got: ${this.crossUserSubscriptionError.message}`,
    )
  },
)
