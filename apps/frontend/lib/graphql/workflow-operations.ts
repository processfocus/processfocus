import { Data, Effect } from "effect"
import { processWorkflowQuery } from "./workflow-queries"
import { GraphQLService } from "@/lib/effect/services/graphql"
import type { ProcessWorkflowQuery } from "@/lib/generated/gql/graphql"

/**
 * Custom error type for workflow data fetching
 */
class WorkflowDataError extends Data.TaggedError("WorkflowDataError")<{
  readonly reason: "fetch_failed" | "missing_workflow"
  readonly message: string
}> {}

/**
 * Validated workflow data with guaranteed non-null workflow
 */
type ValidatedWorkflowData = Omit<ProcessWorkflowQuery, "processWorkflow"> & {
  processWorkflow: NonNullable<ProcessWorkflowQuery["processWorkflow"]>
}

/**
 * Fetch workflow data for a process using Effect and GraphQLService.
 * @param processPath - The path of the process to fetch workflow for
 * @returns Effect that yields validated workflow data or fails with WorkflowDataError
 */
export const fetchProcessWorkflowEffect = (processPath: string) =>
  Effect.gen(function* () {
    const graphql = yield* GraphQLService

    // Fetch data via GraphQL service
    const data = yield* graphql
      .request<ProcessWorkflowQuery>(processWorkflowQuery, { processPath })
      .pipe(
        Effect.mapError(
          (error) =>
            new WorkflowDataError({
              reason: "fetch_failed",
              message: error.message,
            }),
        ),
      )

    // Validate processWorkflow exists
    if (!data.processWorkflow) {
      yield* Effect.fail(
        new WorkflowDataError({
          reason: "missing_workflow",
          message: `No workflow data available for process: ${processPath}`,
        }),
      )
    }

    return data as ValidatedWorkflowData
  })
