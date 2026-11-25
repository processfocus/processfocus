import { NumberFromString } from "@pf/form-schema"
import "server-only"
import { Schema as ES, Effect } from "effect"

type NextParams = Promise<Record<string, string | string[] | undefined>>

export const decodeParamsUnknown =
  <S extends ES.Constraint>(schema: S) =>
  (
    params: NextParams,
  ): Effect.Effect<S["Type"], ES.SchemaError, S["DecodingServices"]> =>
    Effect.promise(() => params).pipe(
      Effect.flatMap(ES.decodeUnknownEffect(schema)),
    )

export const decodeSearchParamsUnknown = decodeParamsUnknown

/**
 * Common route parameter schemas for reuse across pages.
 */

/**
 * Schema for validating a process ID parameter.
 * Ensures the ID is a non-empty string.
 */
export const ProcessIdParams = ES.Struct({
  processId: ES.NonEmptyString,
})

/**
 * Schema for validating a process path parameter.
 * Process paths should be non-empty strings.
 */
export const ProcessPathParams = ES.Struct({
  path: ES.NonEmptyString,
})

/**
 * Schema for validating an execution ID parameter.
 * Ensures the ID is a non-empty string.
 */
export const ExecutionIdParams = ES.Struct({
  executionId: ES.NonEmptyString,
})

/**
 * Schema for validating pagination search parameters.
 */
export const PaginationSearchParams = ES.Struct({
  page: NumberFromString.pipe(ES.withDecodingDefaultType(Effect.succeed(1))),
  pageSize: NumberFromString.pipe(
    ES.withDecodingDefaultType(Effect.succeed(10)),
  ),
})

/**
 * Schema for validating filter search parameters.
 */
export const FilterSearchParams = ES.Struct({
  query: ES.optional(ES.String),
  category: ES.optional(ES.String),
  status: ES.optional(ES.String),
})
