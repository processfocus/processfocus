import { Console, Effect, Schema } from "effect"
import type { HttpClient } from "effect/http"
import { CliError } from "../../errors"
import { graphqlRequest } from "../../utils/graphql-client"
import {
  getListMetadata,
  requireListOperation,
  resultSelection,
} from "../../utils/list-metadata"

export const runListsList: Effect.Effect<
  void,
  CliError,
  HttpClient.HttpClient
> = Effect.gen(function* () {
  const data = yield* graphqlRequest("query { availableLists { path } }")
  const lists = yield* Schema.decodeUnknownEffect(
    Schema.Array(Schema.Struct({ path: Schema.String })),
  )(data["availableLists"]).pipe(
    Effect.mapError(
      () =>
        new CliError({
          code: "INVALID_RESPONSE",
          message:
            "Invalid available Lists response. Check the organisation API version.",
        }),
    ),
  )
  const metadata = yield* Effect.forEach(lists, ({ path }) =>
    getListMetadata(path),
  )
  yield* Console.log(JSON.stringify(metadata))
})

export const runListsDescribe = (
  path: string,
): Effect.Effect<void, CliError, HttpClient.HttpClient> =>
  getListMetadata(path).pipe(
    Effect.flatMap((metadata) => Console.log(JSON.stringify(metadata))),
  )

export interface RecordListOptions {
  readonly page?: number | undefined
  readonly limit?: number | undefined
  readonly filter?: string | undefined
  readonly sort?: string | undefined
}

export const runRecordsRead = (
  path: string,
  request:
    | { readonly kind: "browse"; readonly options: RecordListOptions }
    | { readonly kind: "detail"; readonly id: string },
): Effect.Effect<void, CliError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const variables: Record<string, unknown> = {}
    if (request.kind === "detail") variables["id"] = request.id
    else {
      const { page, limit, filter, sort } = request.options
      for (const [name, value] of [
        ["page", page],
        ["limit", limit],
      ] as const) {
        if (value !== undefined) {
          if (!Number.isInteger(value) || value < 1)
            return yield* new CliError({
              code: "INVALID_ARGUMENT",
              message: `--${name} must be a positive integer.`,
            })
          variables[name] = value
        }
      }
      if (filter !== undefined) variables["filter"] = filter
      if (sort !== undefined) {
        variables["sort"] = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Struct({
              field: Schema.String,
              direction: Schema.Literals(["ASC", "DESC"]),
            }),
          ),
        )(sort).pipe(
          Effect.mapError(
            () =>
              new CliError({
                code: "INVALID_ARGUMENT",
                message:
                  '--sort must be JSON with "field" and "direction" (ASC or DESC). Use lists describe for sortableFields.',
              }),
          ),
        )
      }
    }
    const metadata = yield* getListMetadata(path)
    const operation = yield* requireListOperation(metadata, request.kind)
    const definitions: string[] = []
    const arguments_: string[] = []
    for (const name of Object.keys(variables)) {
      const argument = operation.arguments.find(
        (argument) => argument.name === name,
      )
      if (!argument)
        return yield* new CliError({
          code: "INVALID_ARGUMENT",
          message: `This List does not support ${name}. Run pforg lists describe ${path}.`,
        })
      definitions.push(`$${name}: ${argument.type}`)
      arguments_.push(`${name}: $${name}`)
    }
    const data = yield* graphqlRequest(
      `query ReadList${definitions.length ? `(${definitions.join(", ")})` : ""} {
    result: ${operation.name}${arguments_.length ? `(${arguments_.join(", ")})` : ""}${resultSelection(operation.result)}
  }`,
      { variables },
    )
    if (data["result"] === undefined)
      return yield* new CliError({
        code: "INVALID_RESPONSE",
        message: "GraphQL response is missing the List result.",
      })
    yield* Console.log(JSON.stringify(data["result"]))
  })
