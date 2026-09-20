import "server-only"
import {
  decodeParamsUnknown,
  decodeSearchParamsUnknown,
} from "@mcrovero/effect-nextjs/Params"
import { Schema as ES } from "effect"

/**
 * Re-export param validation utilities from @mcrovero/effect-nextjs
 * for easier access throughout the application.
 */
export { decodeParamsUnknown, decodeSearchParamsUnknown }

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
  page: ES.NumberFromString.pipe(ES.optionalWith({ default: () => 1 })),
  pageSize: ES.NumberFromString.pipe(ES.optionalWith({ default: () => 10 })),
})

/**
 * Schema for validating filter search parameters.
 */
export const FilterSearchParams = ES.Struct({
  query: ES.optional(ES.String),
  category: ES.optional(ES.String),
  status: ES.optional(ES.String),
})
