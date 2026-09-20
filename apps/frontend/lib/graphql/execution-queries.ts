import type { GraphQLClient } from "graphql-request"
import { graphql } from "@/lib/generated/gql"

const processStateForExecutionQuery = graphql(`
  query ProcessStateForExecution($executionId: ID!) {
    processStateForExecution(executionId: $executionId)
  }
`)

export const fetchProcessStateForExecution = async (
  client: GraphQLClient,
  executionId: string,
) => {
  const data = await client.request(processStateForExecutionQuery, {
    executionId,
  })
  return data.processStateForExecution
}

const restartExecutionMutation = graphql(`
  mutation RestartExecution($executionId: ID!) {
    restartExecution(executionId: $executionId) {
      success
      restartedCount
      error
    }
  }
`)

/**
 * Restart a failed execution
 * @param client - GraphQL client to use
 * @param executionId - The execution ID to restart
 * @returns The result of the restart operation
 */
export const restartExecution = async (
  client: GraphQLClient,
  executionId: string,
) => {
  const data = await client.request(restartExecutionMutation, { executionId })
  return data.restartExecution
}

const abandonExecutionMutation = graphql(`
  mutation AbandonExecution($executionId: ID!, $reason: String) {
    abandonExecution(executionId: $executionId, reason: $reason) {
      success
      error
    }
  }
`)

/**
 * Abandon a running execution
 * @param client - GraphQL client to use
 * @param executionId - The execution ID to abandon
 * @param reason - Optional reason for abandoning the execution
 * @returns The result of the abandon operation
 */
export const abandonExecution = async (
  client: GraphQLClient,
  executionId: string,
  reason?: string,
) => {
  const data = await client.request(abandonExecutionMutation, {
    executionId,
    reason,
  })
  return data.abandonExecution
}
