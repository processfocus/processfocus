import { Console, Effect, Schema } from "effect"
import type { HttpClient } from "effect/http"
import { CliError } from "../../errors"
import { readCredentials } from "../../utils/credentials"
import { graphqlRequest } from "../../utils/graphql-client"

const RestartExecutionResult = Schema.Struct({
  success: Schema.Boolean,
  restartedCount: Schema.Number,
  error: Schema.NullOr(Schema.String),
})

const RESTART_EXECUTION_MUTATION = `
  mutation RestartExecution($executionId: ID!) {
    restartExecution(executionId: $executionId) {
      success
      restartedCount
      error
    }
  }
`

export const runExecutionRestart = (
  executionId: string,
): Effect.Effect<void, CliError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    if (!executionId.trim()) {
      return yield* new CliError({ message: "execution-id must not be blank" })
    }

    const data = yield* graphqlRequest(RESTART_EXECUTION_MUTATION, {
      variables: { executionId },
    })
    const result = yield* Schema.decodeUnknownEffect(RestartExecutionResult)(
      data["restartExecution"],
    ).pipe(
      Effect.mapError(
        (cause) =>
          new CliError({
            message: "GraphQL restart response has an invalid payload",
            cause,
          }),
      ),
    )
    // Mutation-level errors are data, so do not pass through the client's
    // GraphQL error redaction. Protect the credential here as well.
    const token = readCredentials()?.accessToken
    const error =
      result.error && token
        ? result.error.replaceAll(token, "[REDACTED]")
        : result.error
    if (!result.success) {
      return yield* new CliError({
        message: `Execution restart failed: ${error || "Check the execution's state and your restart permission."}`,
      })
    }

    yield* Console.log(JSON.stringify({ ...result, error }))
  })
