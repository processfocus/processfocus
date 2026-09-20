import { Context, Data, type Effect } from "effect"

/**
 * Provider-neutral description of executable source supplied by an
 * organisation-owned plugin.
 */
export interface ExecutorSource {
  readonly context: string
  readonly definition: string
}

/**
 * Organisation-declared executor behavior. Hosts interpret only extensions
 * they own and otherwise treat the descriptor as opaque artifact data.
 */
export interface ExecutorDescriptor {
  readonly id: string
  readonly extensions: Readonly<Record<string, unknown>>
}

/** Invocation passed from organisation code to a runtime executor adapter. */
export interface ExecutorInvocation {
  readonly source: ExecutorSource
  readonly input: unknown
  readonly descriptor?: ExecutorDescriptor | undefined
}

/** Runtime identifiers for the job that requested execution. */
export interface ExecutorJobContext {
  readonly todoId: string
  readonly stepPath: string
}

/**
 * Result understood by the generic system-step engine without depending on
 * an organisation plugin implementation.
 */
export type ExecutorResult =
  | { readonly _tag: "Completed"; readonly output: Record<string, unknown> }
  | {
      readonly _tag: "Deferred"
      readonly stateUpdate?: Record<string, unknown>
    }

export class ExecutorError extends Data.TaggedError("ExecutorError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Host capability implemented by platform adapters such as local Docker or
 * AWS CodeBuild. Organisation-owned plugins consume only this contract.
 */
export class ExecutorHost extends Context.Tag(
  "@processfocus/runtime/ExecutorHost",
)<
  ExecutorHost,
  {
    readonly run: (
      invocation: ExecutorInvocation,
      jobContext: ExecutorJobContext,
    ) => Effect.Effect<ExecutorResult, ExecutorError>
  }
>() {}
