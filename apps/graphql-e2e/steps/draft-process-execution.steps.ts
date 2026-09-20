import assert from "node:assert"
import { Then, When } from "@cucumber/cucumber"
import type { TestWorld } from "../support/world"

When(
  "I query for draft process executions with limit {int}",
  { timeout: 30000 },
  async function (this: TestWorld, limit: number) {
    const result = await this.executeGraphQL<{
      pullDraftProcessExecution: {
        documents: Array<{
          id: string
          name: string | null
          state: unknown
          deleted: boolean
        }>
        checkpoint: {
          id: string
          updatedAt: number
        } | null
      }
    }>(
      `
      query PullDraftProcessExecution($limit: Int!) {
        pullDraftProcessExecution(checkpoint: null, limit: $limit) {
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
    `,
      { limit },
    )
    this.draftProcessExecutionResult = result.pullDraftProcessExecution
  },
)

Then(
  "I should receive a valid draft process execution response",
  function (this: TestWorld) {
    assert.ok(
      this.draftProcessExecutionResult,
      "Draft process execution result should be defined",
    )
    assert.ok(
      Array.isArray(this.draftProcessExecutionResult.documents),
      "Documents should be an array",
    )
    // The response structure is valid - documents may be empty if none exist
  },
)

When(
  "I push a new draft process execution",
  { timeout: 30000 },
  async function (this: TestWorld) {
    // First, query for an existing process to get valid processId and startStepPath
    const processResult = await this.executeGraphQL<{
      pullProcess: {
        documents: Array<{
          id: string
          name: string
          path: string
          startStepPath: string
        }>
      }
    }>(
      `
    query GetProcess {
      pullProcess(checkpoint: null, limit: 1) {
        documents {
          id
          name
          path
          startStepPath
        }
      }
    }
  `,
    )

    assert.ok(
      processResult.pullProcess.documents.length > 0,
      "Should have at least one process",
    )
    // biome-ignore lint/style/noNonNullAssertion: checked above
    const process = processResult.pullProcess.documents[0]!

    // Generate a unique ID for this draft
    const draftId = `draft-e2e-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`
    this.pushedDraftId = draftId
    this.pushedProcessName = process.name

    const now = Date.now()
    const nowISO = new Date(now).toISOString()

    const result = await this.executeGraphQL<{
      pushDraftProcessExecution: Array<{ id: string }>
    }>(
      `
    mutation PushDraftProcessExecution($writeRows: [DraftProcessExecutionInputPushRow!]) {
      pushDraftProcessExecution(writeRows: $writeRows) {
        id
      }
    }
  `,
      {
        writeRows: [
          {
            // No assumedMasterState for new document
            newDocumentState: {
              id: draftId,
              processId: process.id,
              startStepPath: process.startStepPath,
              name: "E2E Test Draft",
              state: { testField: "test value", amount: 100 },
              fieldsCompleted: 1,
              totalFields: 2,
              deleted: false,
              lastSaved: nowISO,
              updatedAt: now,
            },
          },
        ],
      },
    )

    // pushDraftProcessExecution returns conflicts - empty array means success
    assert.ok(
      Array.isArray(result.pushDraftProcessExecution),
      "Push result should be an array",
    )
    assert.strictEqual(
      result.pushDraftProcessExecution.length,
      0,
      "Push should have no conflicts",
    )
  },
)

Then(
  "the last subscription event should contain the pushed draft",
  function (this: TestWorld) {
    assert.ok(
      this.subscriptionEvents.length > 0,
      "Should have received subscription events",
    )
    assert.ok(this.pushedDraftId, "Pushed draft ID should be set")
    assert.ok(this.pushedProcessName, "Pushed process name should be set")

    const lastEvent = this.subscriptionEvents.at(-1)
    assert.ok(lastEvent?.data, "Last event should have data")

    // The event data structure is { streamDraftProcessExecution: { documents: [...], checkpoint: {...} } }
    const streamData = (
      lastEvent.data as {
        streamDraftProcessExecution?: {
          documents: Array<{ id: string; name: string; state: unknown }>
        }
      }
    ).streamDraftProcessExecution

    assert.ok(streamData, "Event should contain streamDraftProcessExecution")
    assert.ok(
      Array.isArray(streamData.documents),
      "Event should contain documents array",
    )

    // Find our pushed draft in the documents
    const pushedDoc = streamData.documents.find(
      (doc) => doc.id === this.pushedDraftId,
    )
    assert.ok(
      pushedDoc,
      `Should find pushed draft with ID ${this.pushedDraftId}`,
    )
    // The name comes from the process, not from the push input
    assert.strictEqual(pushedDoc.name, this.pushedProcessName)
    assert.deepStrictEqual(pushedDoc.state, {
      testField: "test value",
      amount: 100,
    })
  },
)
