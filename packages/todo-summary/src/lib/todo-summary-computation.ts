import { Cache, Context, Effect, Layer, Option } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import {
  type InvalidProcessStateError,
  ProviderUserQueries,
  type ProviderUserRow,
  StepCompletionOperations,
  type TodoRow,
} from "@pf/graphql-db-operations"
import {
  OrganisationProvider,
  type ProviderUserDisplayResolver,
  type StepMeta,
  type Summary,
  type SummaryContext,
  buildFlowContext,
} from "@pf/process"

const providerUserDisplayValue = (row: ProviderUserRow): string => {
  const name = row.name.trim()
  if (name.length > 0) return name

  const email = row.email.trim()
  if (email.length > 0) return email

  return row.id
}

/**
 * Build a request-local provider-user display resolver.
 *
 * Uses Effect.cachedFunction so concurrent lookups for the same key share a
 * single in-flight query instead of racing a check-then-act Map.
 */
export const makeProviderUserDisplayResolver = (
  providerUserQueries: ProviderUserQueries["Service"],
): Effect.Effect<ProviderUserDisplayResolver> =>
  Cache.make({
    capacity: Number.MAX_SAFE_INTEGER,
    lookup: (providerUserIdOrEmail: string) => {
      // Provider-user IDs use pvu-*; provider-user emails contain "@".
      // Unknown non-email values use the ID path and safely fall back below.
      const isProviderUserId = providerUserIdOrEmail.startsWith("pvu-")
      const isProviderUserEmail = providerUserIdOrEmail.includes("@")
      const query = isProviderUserId
        ? providerUserQueries.queryProviderUserByProviderUserId(
            providerUserIdOrEmail,
          )
        : isProviderUserEmail
          ? providerUserQueries.queryProviderUserByEmail(providerUserIdOrEmail)
          : providerUserQueries.queryProviderUserByProviderUserId(
              providerUserIdOrEmail,
            )

      return query.pipe(
        Effect.map((providerUser) =>
          Option.isSome(providerUser)
            ? providerUserDisplayValue(providerUser.value)
            : providerUserIdOrEmail,
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to resolve provider-user display value", {
            cause,
            providerUserIdOrEmail,
          }).pipe(Effect.as(providerUserIdOrEmail)),
        ),
      )
    },
  }).pipe(
    Effect.map((cache) => ({
      display: (key: string) => Cache.get(cache, key),
    })),
  )

/** Bound summary callback fan-out to avoid DB exhaustion. */
const ENRICH_CONCURRENCY = 10

/**
 * Service for computing summaries for todos.
 *
 * This service batch fetches process states and completed steps,
 * then uses Form.getSummary() to compute summary for each todo.
 */
export class TodoSummaryComputation extends Context.Service<
  TodoSummaryComputation,
  {
    /**
     * Enrich todos with computed summaries.
     *
     * For each todo:
     * 1. Fetches process state from database
     * 2. Fetches completed steps for the process execution
     * 3. Builds FlowContext from completed steps
     * 4. Calls Form.getSummary() if the step has a summary function
     * 5. Converts summary to array format for GraphQL
     *
     * @param todos - TodoRows to enrich with summaries
     * @returns TodoRows with summary field populated
     */
    readonly enrichWithSummaries: (
      todos: readonly TodoRow[],
    ) => Effect.Effect<TodoRow[], SqlError | InvalidProcessStateError>
  }
>()("@pf/todo-summary/TodoSummaryComputation") {}

/**
 * Live implementation of TodoSummaryComputation.
 *
 * Depends on:
 * - StepCompletionOperations: For database queries
 * - OrganisationProvider: For accessing Form definitions with summary functions
 */
export const TodoSummaryComputationLive = Layer.effect(
  TodoSummaryComputation,
  Effect.gen(function* () {
    const stepCompletionOps = yield* StepCompletionOperations
    const providerUserQueries = yield* ProviderUserQueries
    const orgProvider = yield* OrganisationProvider
    const org = orgProvider.organisation

    return {
      enrichWithSummaries: (todos: readonly TodoRow[]) =>
        Effect.gen(function* () {
          if (todos.length === 0) {
            return []
          }

          // 1. Batch fetch process states for all todos
          const todoIds = todos.map((t) => t.id)
          const processStates =
            yield* stepCompletionOps.getProcessStatesByTodoIds(todoIds)

          // Create map for O(1) lookup: todoId -> process state info
          const stateMap = new Map(
            processStates.map((ps) => [
              ps.todoId,
              {
                state: ps.state,
                stepPath: ps.stepPath,
                processExecutionId: ps.processExecutionId,
                processStartedAt: ps.processStartedAt,
                itemData: ps.itemData,
              },
            ]),
          )

          // 2. Only fetch completed steps for executions that need summaries.
          const uniqueExecutionIds = [
            ...new Set(
              processStates
                .filter((ps) => org.formByPath(ps.stepPath)?.hasSummaryFunction)
                .map((ps) => ps.processExecutionId),
            ),
          ]
          const completedStepsMap =
            yield* stepCompletionOps.getCompletedStepsForExecutions(
              uniqueExecutionIds,
            )
          // Request-local: one cached resolver per enrichWithSummaries call
          const providerUserDisplay =
            yield* makeProviderUserDisplayResolver(providerUserQueries)

          // 3. Compute summaries for each todo
          const todosWithSummary: TodoRow[] = yield* Effect.all(
            todos.map((row) =>
              Effect.gen(function* () {
                const stateInfo = stateMap.get(row.id)
                if (!stateInfo) {
                  // No process state found, return row with empty summary
                  return { ...row, summary: [] }
                }

                // Find the Form step in the organisation
                const form = org.formByPath(stateInfo.stepPath)
                if (!form?.hasSummaryFunction) {
                  // Not a Form or no summary function, return row with empty summary
                  return { ...row, summary: [] }
                }

                // Build FlowContext from completed steps
                const completedSteps =
                  completedStepsMap.get(stateInfo.processExecutionId) ?? []
                const ctx: SummaryContext<Record<string, StepMeta>> = {
                  ...buildFlowContext(
                    stateInfo.processExecutionId,
                    stateInfo.processStartedAt,
                    completedSteps,
                  ),
                  providerUserDisplay,
                }

                // For forEach forms, pass item_data to getSummary
                const item = stateInfo.itemData ?? undefined

                // Compute summary from process state with context
                // Cast is safe: Form.getSummary handles invalid state gracefully
                // The ctx cast is needed because Form's TSteps generic is erased at runtime
                // when retrieved via formByPath, but the runtime values are compatible
                const summaryRecord: Summary = yield* form.getSummary(
                  stateInfo.state as Record<string, never>,
                  ctx as SummaryContext<Record<string, never>>,
                  item as undefined,
                )
                // Convert Record<string, string> to array format for GraphQL
                const summary = Object.entries(summaryRecord).flatMap(
                  ([label, value]) => {
                    if (value === null || value === undefined) {
                      return []
                    }

                    return [{ label, value: String(value) }]
                  },
                )
                return { ...row, summary }
              }),
            ),
            { concurrency: ENRICH_CONCURRENCY },
          )

          return todosWithSummary
        }),
    }
  }),
)
