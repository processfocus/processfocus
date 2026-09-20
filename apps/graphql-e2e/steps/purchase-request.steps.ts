import assert from "node:assert"
import { Then, When } from "@cucumber/cucumber"
import type { TestWorld } from "../support/world"

/**
 * Purchase request specific step definitions.
 */

When(
  "I start a purchase request for item {string} with value {string}",
  { timeout: 30000 },
  async function (this: TestWorld, item: string, value: string) {
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
      input: { item, value },
    })

    this.startProcessResult = result.startFinancePurchaseRequest

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
  "I complete the first todo with manager approval",
  { timeout: 30000 },
  async function (this: TestWorld) {
    assert.ok(this.todoDocuments, "No todos available")
    assert.ok(this.todoDocuments.length > 0, "No todos to complete")

    // biome-ignore lint/style/noNonNullAssertion: length check above guarantees this exists
    const todo = this.todoDocuments[0]!

    const mutation = `
      mutation CompleteManagerApproval($todoId: ID!, $input: FinancePurchaseRequestManagerApproval!) {
        completeFinancePurchaseRequestManagerApproval(todoId: $todoId, input: $input) {
          executionId
          stepPath
          timestamp
        }
      }
    `

    const result = await this.executeGraphQL<{
      completeFinancePurchaseRequestManagerApproval: {
        executionId: string
        stepPath: string
        timestamp: string
      }
    }>(mutation, {
      todoId: todo.id,
      input: { check: true },
    })

    this.completeStepResult =
      result.completeFinancePurchaseRequestManagerApproval
  },
)

When(
  "I complete the first todo with procurement approval",
  { timeout: 30000 },
  async function (this: TestWorld) {
    assert.ok(this.todoDocuments, "No todos available")
    assert.ok(this.todoDocuments.length > 0, "No todos to complete")

    // biome-ignore lint/style/noNonNullAssertion: length check above guarantees this exists
    const todo = this.todoDocuments[0]!

    const mutation = `
      mutation CompleteProcurementApproval($todoId: ID!, $input: FinancePurchaseRequestProcurementApproval!) {
        completeFinancePurchaseRequestProcurementApproval(todoId: $todoId, input: $input) {
          executionId
          stepPath
          timestamp
        }
      }
    `

    const result = await this.executeGraphQL<{
      completeFinancePurchaseRequestProcurementApproval: {
        executionId: string
        stepPath: string
        timestamp: string
      }
    }>(mutation, {
      todoId: todo.id,
      input: { check: true },
    })

    this.completeStepResult =
      result.completeFinancePurchaseRequestProcurementApproval
  },
)

When(
  "I complete the first todo with purchase completion",
  { timeout: 30000 },
  async function (this: TestWorld) {
    assert.ok(this.todoDocuments, "No todos available")
    assert.ok(this.todoDocuments.length > 0, "No todos to complete")

    // biome-ignore lint/style/noNonNullAssertion: length check above guarantees this exists
    const todo = this.todoDocuments[0]!

    const mutation = `
      mutation CompletePurchase($todoId: ID!, $input: FinancePurchaseRequestPurchase!) {
        completeFinancePurchaseRequestPurchase(todoId: $todoId, input: $input) {
          executionId
          stepPath
          timestamp
        }
      }
    `

    const result = await this.executeGraphQL<{
      completeFinancePurchaseRequestPurchase: {
        executionId: string
        stepPath: string
        timestamp: string
      }
    }>(mutation, {
      todoId: todo.id,
      input: { completed: true },
    })

    this.completeStepResult = result.completeFinancePurchaseRequestPurchase
  },
)

When(
  "I query the purchase order list",
  { timeout: 30000 },
  async function (this: TestWorld) {
    const query = `
      query ListPurchaseOrders {
        listPurchaseOrders(page: 1, limit: 100) {
          items {
            id
            item
            price
          }
          totalCount
        }
      }
    `

    const result = await this.executeGraphQL<{
      listPurchaseOrders: {
        items: Array<{ id: string; item: string; price: number }>
        totalCount: number
      }
    }>(query, {})

    this.purchaseOrderListCount = result.listPurchaseOrders.totalCount
  },
)

Then(
  "the purchase order list should have {int} more item(s) than before",
  { timeout: 30000 },
  async function (this: TestWorld, expectedIncrease: number) {
    const query = `
      query ListPurchaseOrders {
        listPurchaseOrders(page: 1, limit: 100) {
          items {
            id
            item
            price
          }
          totalCount
        }
      }
    `

    const result = await this.executeGraphQL<{
      listPurchaseOrders: {
        items: Array<{ id: string; item: string; price: number }>
        totalCount: number
      }
    }>(query, {})

    const previousCount = this.purchaseOrderListCount ?? 0
    const currentCount = result.listPurchaseOrders.totalCount
    const actualIncrease = currentCount - previousCount

    assert.strictEqual(
      actualIncrease,
      expectedIncrease,
      `Expected purchase order list to increase by ${expectedIncrease}, but it increased by ${actualIncrease} (was ${previousCount}, now ${currentCount})`,
    )
  },
)
