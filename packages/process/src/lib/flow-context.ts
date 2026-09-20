/**
 * Flow context types and utilities for accessing step metadata in callbacks.
 *
 * Provides type-safe access to information about who completed previous steps
 * in a process flow.
 */

import { DateTime, type Effect, type Schema } from "effect"
import type { FlattenFields } from "@pf/form-submission-schema"

// =============================================================================
// Type-level CamelCase conversion
// =============================================================================

/**
 * Capitalize the first letter of a string at the type level.
 */
type Capitalize<S extends string> = S extends `${infer F}${infer R}`
  ? `${Uppercase<F>}${R}`
  : S

/**
 * Convert a string to camelCase at the type level.
 * Handles spaces, underscores, and hyphens as word separators.
 *
 * @example
 * type T1 = CamelCase<"Submit time off request"> // "submitTimeOffRequest"
 * type T2 = CamelCase<"approve_request"> // "approveRequest"
 * type T3 = CamelCase<"my-step"> // "myStep"
 * type T4 = CamelCase<"alreadyCamel"> // "alreadycamel" (lowercased)
 */
export type CamelCase<S extends string> =
  S extends `${infer Word} ${infer Rest}`
    ? `${Lowercase<Word>}${CamelCaseRest<Rest>}`
    : S extends `${infer Word}_${infer Rest}`
      ? `${Lowercase<Word>}${CamelCaseRest<Rest>}`
      : S extends `${infer Word}-${infer Rest}`
        ? `${Lowercase<Word>}${CamelCaseRest<Rest>}`
        : Lowercase<S>

/**
 * Helper for CamelCase - processes remaining words with capitalization.
 */
type CamelCaseRest<S extends string> = S extends `${infer Word} ${infer Rest}`
  ? `${Capitalize<Lowercase<Word>>}${CamelCaseRest<Rest>}`
  : S extends `${infer Word}_${infer Rest}`
    ? `${Capitalize<Lowercase<Word>>}${CamelCaseRest<Rest>}`
    : S extends `${infer Word}-${infer Rest}`
      ? `${Capitalize<Lowercase<Word>>}${CamelCaseRest<Rest>}`
      : Capitalize<Lowercase<S>>

// =============================================================================
// Runtime camelCase conversion
// =============================================================================

/**
 * Convert a string to a valid camelCase JavaScript identifier.
 * Handles spaces, underscores, hyphens, and removes invalid characters.
 *
 * @example
 * toCamelCase("Submit time off request") // "submitTimeOffRequest"
 * toCamelCase("approve_request") // "approveRequest"
 * toCamelCase("my-step") // "myStep"
 * toCamelCase("123 invalid start") // "invalidStart" (removes leading digits)
 */
export function toCamelCase(str: string): string {
  // Split on spaces, underscores, hyphens
  const words = str.split(/[\s_-]+/).filter((w) => w.length > 0)

  if (words.length === 0) {
    return "unnamed"
  }

  let isFirstWord = true
  const result = words
    .map((word) => {
      // Remove non-alphanumeric characters except for the word content
      const cleaned = word.replace(/[^a-zA-Z0-9]/g, "")
      if (cleaned.length === 0) return ""

      if (isFirstWord) {
        // First word: lowercase, but remove leading digits
        const noLeadingDigits = cleaned.replace(/^[0-9]+/, "")
        if (noLeadingDigits.length > 0) {
          isFirstWord = false
          return noLeadingDigits.toLowerCase()
        }
        // Word was all digits, skip it but don't mark as first word consumed
        return ""
      }
      // Subsequent words: capitalize first letter
      return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase()
    })
    .join("")

  // If result starts with a digit or is empty, prefix with underscore
  if (result.length === 0 || /^[0-9]/.test(result)) {
    return `_${result}`
  }

  return result
}

/**
 * Extract the step ID from a step path.
 * Step paths are like "OrgUnit/Process/StepId" or "/OrgUnit/Process/StepId" - we want "StepId".
 *
 * Handles optional leading slash for backward compatibility.
 */
export function getStepIdFromPath(stepPath: string): string {
  const parts = stepPath.split("/").filter((part) => part.length > 0)
  return parts[parts.length - 1] ?? stepPath
}

// =============================================================================
// Step metadata types
// =============================================================================

/**
 * Basic user info from the user table.
 * This is minimal - just the auth identity.
 */
export interface StepUserInfo {
  /** User ID (e.g., "usr-01ABC...") */
  userId: string
  /** Subject from auth provider (might be email, might be UUID) */
  sub: string
}

/**
 * Provider user info from the provider user table.
 * Richer identity information for users who are provider users.
 */
export interface StepProviderUserInfo {
  /** Provider user ID (e.g., "emp-01ABC...") */
  id: string
  /** Full name */
  name: string
  /** First name */
  firstName: string
  /** Last name */
  lastName: string
  /** Email address */
  email: string
  /** Profile picture URL */
  picture: string
}

/**
 * Metadata about a completed step.
 * Provider user info is always present - for M2M/system users without provider user records,
 * the user's sub is used as fallback for name/email fields.
 */
export interface StepMeta {
  /** The user who completed the step */
  user: StepUserInfo
  /** Provider user info - always present (uses user.sub as fallback for M2M users) */
  providerUser: StepProviderUserInfo
  /** When the step was completed */
  completedAt: DateTime.DateTime
}

/**
 * Metadata about a completed Form step.
 * Alias for StepMeta - both now guarantee providerUser is present.
 */
export type FormStepMeta = StepMeta

/**
 * Process-level metadata.
 */
export interface ProcessMeta {
  /** Process execution ID */
  executionId: string
  /** When the process was started */
  startedAt: DateTime.DateTime
  /** Metadata about the first step (who started the process) */
  startStep: StepMeta
}

/**
 * The context object passed to form(), summary(), and condition callbacks.
 * Provides access to process and step metadata.
 *
 * @typeParam TSteps - Record mapping step keys (camelCase) to StepMeta
 */
export interface FlowContext<TSteps extends Record<string, StepMeta>> {
  /** Process-level metadata */
  process: ProcessMeta
  /** Completed step metadata, keyed by camelCase step ID */
  step: TSteps
}

/**
 * Resolves persisted provider-user identifiers to request-time display values.
 * Process state should keep the submitted id/email; summaries can use this to
 * display the current name or email without denormalizing identity data.
 */
export interface ProviderUserDisplayResolver {
  readonly display: (
    providerUserIdOrEmail: string,
  ) => Effect.Effect<string, never>
}

/**
 * Context passed to summary callbacks.
 */
export interface SummaryContext<TSteps extends Record<string, StepMeta>>
  extends FlowContext<TSteps> {
  readonly providerUserDisplay: ProviderUserDisplayResolver
}

// =============================================================================
// Data types for building context from DB
// =============================================================================

/**
 * Raw data from database query for a completed step.
 * Note: Provider user fields are always populated via COALESCE in the SQL query,
 * using user.sub as fallback for M2M/system users without provider user records.
 */
export interface CompletedStepData {
  stepPath: string
  userId: string
  userSub: string
  providerUserId: string
  providerUserName: string
  providerUserFirstName: string
  providerUserLastName: string
  providerUserEmail: string
  providerUserPicture: string
  completedAt: DateTime.DateTime
}

/**
 * Build a FlowContext from database query results.
 *
 * @param processExecutionId - Current process execution ID
 * @param processStartedAt - When the process was started
 * @param completedSteps - List of completed steps with user/employee info
 * @returns FlowContext object for use in callbacks
 */
export function buildFlowContext(
  processExecutionId: string,
  processStartedAt: DateTime.DateTime,
  completedSteps: CompletedStepData[],
): FlowContext<Record<string, StepMeta>> {
  const stepMap: Record<string, StepMeta> = {}

  for (const step of completedSteps) {
    const stepId = getStepIdFromPath(step.stepPath)
    const key = toCamelCase(stepId)

    stepMap[key] = {
      user: {
        userId: step.userId,
        sub: step.userSub,
      },
      // Provider user is always populated - SQL uses COALESCE to provide
      // fallback values from user.sub for M2M/system users
      providerUser: {
        id: step.providerUserId,
        name: step.providerUserName,
        firstName: step.providerUserFirstName,
        lastName: step.providerUserLastName,
        email: step.providerUserEmail,
        picture: step.providerUserPicture,
      },
      completedAt: step.completedAt,
    }
  }

  // First completed step is the start step
  // Sort by completedAt to ensure we get the earliest
  const sortedSteps = [...completedSteps].sort((a, b) =>
    DateTime.Order(a.completedAt, b.completedAt),
  )
  const firstStep = sortedSteps[0]

  // Helper to create an empty StepMeta for fallback cases
  const emptyStepMeta: StepMeta = {
    user: { userId: "", sub: "" },
    providerUser: {
      id: "",
      name: "",
      firstName: "",
      lastName: "",
      email: "",
      picture: "",
    },
    completedAt: processStartedAt,
  }

  let startStep: StepMeta
  if (firstStep) {
    const firstStepKey = toCamelCase(getStepIdFromPath(firstStep.stepPath))
    const firstStepMeta = stepMap[firstStepKey]
    if (firstStepMeta) {
      startStep = firstStepMeta
    } else {
      // Fallback if key lookup fails (shouldn't happen)
      startStep = emptyStepMeta
    }
  } else {
    // No completed steps yet - this shouldn't happen in practice
    // but provide a fallback
    startStep = emptyStepMeta
  }

  return {
    process: {
      executionId: processExecutionId,
      startedAt: processStartedAt,
      startStep,
    },
    step: stepMap,
  }
}

// =============================================================================
// Type utilities for accumulating steps in FlowPath
// =============================================================================

/**
 * Merge a new step into the accumulated steps record.
 * Used by FlowPath to build up the TSteps type as the flow progresses.
 *
 * @typeParam TSteps - Existing accumulated steps
 * @typeParam TStepId - ID of the step being added
 * @typeParam TMeta - The metadata type (StepMeta for generic, FormStepMeta for Forms)
 */
export type MergeSteps<
  TSteps extends Record<string, StepMeta | FormStepMeta>,
  TStepId extends string,
  TMeta extends StepMeta | FormStepMeta = StepMeta,
> = TSteps & { [K in CamelCase<TStepId>]: TMeta }

/**
 * Merge a Form step - uses FormStepMeta (providerUser is required).
 */
export type MergeFormStep<
  TSteps extends Record<string, StepMeta | FormStepMeta>,
  TStepId extends string,
> = MergeSteps<TSteps, TStepId, FormStepMeta>

/**
 * State contribution type for forEach steps.
 * Instead of flat-merging TOutput into state, forEach steps contribute
 * an array of outputs keyed by the step's camelCase ID.
 *
 * When TIsForm is true, wrapper fields are flattened in each array element
 * to match the canonical flat submission shape.
 */
export type ForEachOutput<
  TId extends string,
  TOutput extends Schema.Struct.Fields | undefined,
  TIsForm extends boolean = false,
> = {
  [K in CamelCase<TId>]: ReadonlyArray<
    TOutput extends Schema.Struct.Fields
      ? TIsForm extends true
        ? FlattenFields<TOutput> extends infer F extends Schema.Struct.Fields
          ? Schema.Schema.Type<ReturnType<typeof Schema.Struct<F>>>
          : Record<string, never>
        : Schema.Schema.Type<ReturnType<typeof Schema.Struct<TOutput>>>
      : Record<string, never>
  >
}
