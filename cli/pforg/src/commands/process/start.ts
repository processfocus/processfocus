import type { HttpClient } from "@effect/platform"
import { Console, Effect, Schema } from "effect"
import { CliError } from "../../errors"
import { graphqlRequest } from "../../utils/graphql-client"

const GRAPHQL_NAME = /^[_A-Za-z][_0-9A-Za-z]*$/

const StartProcessPayloadSchema = Schema.Struct({
  executionId: Schema.NonEmptyString,
  processId: Schema.NonEmptyString,
  processPath: Schema.NonEmptyString,
  timestamp: Schema.NonEmptyString,
  deduplicated: Schema.Boolean,
})

// Parity is enforced by the shared path conversion fixture.
export const pathToPascalCase = (path: string): string =>
  path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) =>
      segment
        .replace(/-/g, " ")
        .split(/\s+/)
        .filter((word) => word.length > 0)
        .map(
          (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
        )
        .join(""),
    )
    .join("")

const mutationNameForProcessPath = (
  processPath: string,
): Effect.Effect<string, CliError> =>
  Effect.gen(function* () {
    const mutationName = `start${pathToPascalCase(processPath)}`
    if (mutationName === "start" || !GRAPHQL_NAME.test(mutationName)) {
      return yield* new CliError({
        message: `Process path cannot be mapped to a start mutation: ${processPath}`,
      })
    }
    return mutationName
  })

const jsonValueToGraphqlLiteral = (
  value: unknown,
): Effect.Effect<string, CliError> =>
  Effect.gen(function* () {
    if (value === null) return "null"

    switch (typeof value) {
      case "string":
        return JSON.stringify(value) ?? '""'
      case "number":
        if (!Number.isFinite(value)) {
          return yield* new CliError({
            message: "--input contains a non-finite number",
          })
        }
        return String(value)
      case "boolean":
        return String(value)
      case "object": {
        if (Array.isArray(value)) {
          const items = yield* Effect.forEach(value, jsonValueToGraphqlLiteral)
          return `[${items.join(", ")}]`
        }

        const fields = yield* Effect.forEach(Object.keys(value), (key) =>
          Effect.gen(function* () {
            if (!GRAPHQL_NAME.test(key)) {
              return yield* new CliError({
                message: `--input contains an invalid field name: ${key}`,
              })
            }
            const fieldValue: unknown = Reflect.get(value, key)
            const literal = yield* jsonValueToGraphqlLiteral(fieldValue)
            return `${key}: ${literal}`
          }),
        )
        return `{${fields.join(", ")}}`
      }
      default:
        return yield* new CliError({
          message: "--input contains an unsupported value",
        })
    }
  })

const parseInput = (input: string): Effect.Effect<string, CliError> =>
  Effect.gen(function* () {
    const parsed: unknown = yield* Effect.try({
      try: () => JSON.parse(input),
      catch: (cause) =>
        new CliError({ message: "--input must be valid JSON", cause }),
    })

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return yield* new CliError({ message: "--input must be a JSON object" })
    }

    return yield* jsonValueToGraphqlLiteral(parsed)
  })

const startMutation = (
  mutationName: string,
  input: string | undefined,
): Effect.Effect<string, CliError> =>
  Effect.gen(function* () {
    const inputArgument =
      input === undefined ? "" : `(input: ${yield* parseInput(input)})`

    return `mutation StartProcess {
  ${mutationName}${inputArgument} {
    executionId
    processId
    processPath
    timestamp
    deduplicated
  }
}`
  })

export const runProcessStart = (
  processPath: string,
  input: string | undefined,
): Effect.Effect<void, CliError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const mutationName = yield* mutationNameForProcessPath(processPath)
    const query = yield* startMutation(mutationName, input)
    const data = yield* graphqlRequest(query)
    const rawPayload = data[mutationName]
    const payload = yield* Schema.decodeUnknown(StartProcessPayloadSchema)(
      rawPayload,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new CliError({
            message: "GraphQL start response has an invalid payload",
            cause,
          }),
      ),
    )

    yield* Console.log(
      JSON.stringify({
        executionId: payload.executionId,
        processId: payload.processId,
        processPath: payload.processPath,
        timestamp: payload.timestamp,
        deduplicated: payload.deduplicated,
      }),
    )
  })
