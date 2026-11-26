import { Data, Effect, Schema } from "effect"
import { defineReadTool } from "./read-tool"
import { graphql } from "@/lib/generated/gql"

const executionsQuery = graphql(`
  query McpExecutions($page: Int!, $limit: Int!, $processPath: String, $status: String) {
    executions(page: $page, limit: $limit, processPath: $processPath, status: $status) {
      page
      limit
      hasNextPage
      nodes { id processPath processName status startedAt finishedAt }
    }
  }
`)

const executionQuery = graphql(`
  query McpExecution($id: ID!) {
    execution(id: $id) {
      id
      processPath
      processName
      status
      startedAt
      finishedAt
      estimatedCompletionAt
      steps { id name path status startedAt completedAt }
    }
  }
`)

const statuses = ["Running", "Completed", "Failed", "Not started", "Abandoned"]
const maxPage = 2147483647
const maxLimit = 100
const defaultLimit = 25
const pageNumber = (maximum: number) =>
  Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum })))

const ListArguments = Schema.Struct({
  page: Schema.optionalKey(pageNumber(maxPage)),
  limit: Schema.optionalKey(pageNumber(maxLimit)),
  processPath: Schema.optionalKey(
    Schema.NonEmptyString.annotate({
      description: "Exact Process path, e.g. /finance/purchase-request.",
    }),
  ),
  status: Schema.optionalKey(Schema.Literals(statuses)),
})

const DetailArguments = Schema.Struct({ id: Schema.NonEmptyString })

class ExecutionUnavailable extends Data.TaggedError("ExecutionUnavailable") {}

const executionLink = (origin: string, id: string) =>
  new URL(`/executions/${encodeURIComponent(id)}`, origin).href

const executionListTool = defineReadTool({
  name: "list_executions",
  description:
    "List Executions you may view, including work started by others. Optionally filter by Process path and recorded status. Start at page 1 with 25 results by default, and continue while hasNextPage is true.",
  args: ListArguments,
  failure: "The runtime did not authorize or return the Execution list.",
  read: (
    { client, origin },
    { page = 1, limit = defaultLimit, processPath, status },
  ) =>
    Effect.tryPromise(() =>
      client.request(executionsQuery, {
        page,
        limit,
        processPath,
        status,
      }),
    ).pipe(
      Effect.map(({ executions }) => ({
        ...executions,
        nodes: executions.nodes.map((node) => ({
          ...node,
          link: executionLink(origin, node.id),
        })),
      })),
    ),
})

const executionDetailTool = defineReadTool({
  name: "get_execution",
  description:
    "Read the recorded status, timeline, current Steps, Dashboard link, and any runtime completion estimate for an Execution you may view.",
  args: DetailArguments,
  failure: "Execution not available.",
  read: ({ client, origin }, args) =>
    Effect.gen(function* () {
      const { execution } = yield* Effect.tryPromise(() =>
        client.request(executionQuery, args),
      )
      if (!execution) return yield* new ExecutionUnavailable()
      const { steps, estimatedCompletionAt, ...progress } = execution
      const isCurrent = (step: (typeof steps)[number]) =>
        step.status === "Waiting" || step.status === "Correction Required"
      return {
        ...progress,
        timeline: steps.filter((step) => step.status !== "Potential"),
        currentSteps:
          progress.status === "Running" ? steps.filter(isCurrent) : [],
        link: executionLink(origin, progress.id),
        ...(estimatedCompletionAt == null ? {} : { estimatedCompletionAt }),
      }
    }),
})

export const executionTools = [executionListTool, executionDetailTool]
