import type { Effect, Layer, Schema } from "effect"
import type { Form, Organisation } from "@pf/process"

/**
 * A type-safe form entry override for providing explicit data to a form step.
 */
export interface FormEntry {
  readonly stepPath: string
  readonly data: Record<string, unknown>
}

/**
 * Creates a type-safe form entry override for a specific form step.
 *
 * @param form - The Form step to provide data for (used for type inference)
 * @param data - The input data matching the form's output schema
 * @returns A FormEntry that the test runner will use instead of auto-generating data
 */
export const formEntry = <TInput extends Schema.Struct.Fields>(
  form: Form<
    // biome-ignore lint/suspicious/noExplicitAny: Form generics erased at runtime
    any,
    // biome-ignore lint/suspicious/noExplicitAny: Form generics erased at runtime
    any,
    TInput,
    string>,
  data: { [K in keyof TInput]: Schema.Schema.Type<TInput[K]> },
): FormEntry => ({
  stepPath: form.node.path,
  data: data as Record<string, unknown>,
})

/**
 * Configuration for the process test runner.
 */
export interface ProcessTestConfig {
  /** The organisation containing the process to test */
  readonly org: Organisation
  /** Path to the process (e.g. "/Org/operations/add-aws-region") */
  readonly processPath: string
  /** Initial process state (for processes with no start form) */
  readonly initialState?: Record<string, unknown>
  /** Optional form data overrides; auto-generated from schemas by default */
  readonly forms?: ReadonlyArray<FormEntry>
  /** Optional setup after organisation hydration and before process start */
  readonly setup?: Effect.Effect<void, unknown, unknown>
  /** Custom DB layer for orgs with custom services (e.g. OrgOperations) */
  // biome-ignore lint/suspicious/noExplicitAny: Layer generics vary per org
  readonly customDbLayer?: Layer.Layer<any, any, any>
}

/**
 * A completed step recorded during process execution.
 */
export interface CompletedStepRecord {
  readonly stepPath: string
  readonly isSystemStep: boolean
}

/**
 * Result of running a process through the test runner.
 */
export interface ProcessTestResult {
  /** The process execution ID */
  readonly executionId: string
  /** Final accumulated process state */
  readonly finalState: Record<string, unknown>
  /** Steps that were completed during execution */
  readonly completedSteps: ReadonlyArray<CompletedStepRecord>
  /** Whether the process ran to completion */
  readonly finished: boolean
}
