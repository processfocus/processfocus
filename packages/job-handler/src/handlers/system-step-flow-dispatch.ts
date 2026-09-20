import {
  QueueService,
  type QueueService as QueueServiceType,
} from "@processfocus/runtime"
import { Data, Effect } from "effect"
import {
  FLOW_EXECUTION_QUEUE,
  FlowExecutionOperations,
} from "@pf/graphql-db-operations"

export const systemStepTodoDispatchId = (todoId: string) =>
  `system-step:${todoId}`

export const startedSystemStepDispatchId = (processExecutionId: string) =>
  `system-step:start:${processExecutionId}`

export class SystemStepFlowDispatchError extends Data.TaggedError(
  "SystemStepFlowDispatchError",
)<{
  readonly message: string
  readonly cause: unknown
}> {}

export const isSystemStepFlowDispatchError = (
  value: unknown,
): value is SystemStepFlowDispatchError =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  value._tag === "SystemStepFlowDispatchError"

export const persistSystemStepFlowDispatch = (params: {
  readonly dispatchId: string
  readonly processExecutionId: string
  readonly scheduledFlowId: string
  readonly onError?: boolean
  readonly errorTag?: string
  readonly flowExecutionOps: FlowExecutionOperations["Type"]
}) =>
  params.flowExecutionOps.insertFlowDispatchJobs([
    {
      sourceScheduledFlowId: params.dispatchId,
      processExecutionId: params.processExecutionId,
      logicalJobId: `flow-execution:${params.scheduledFlowId}`,
      queue: FLOW_EXECUTION_QUEUE,
      payload: {
        scheduledFlowId: params.scheduledFlowId,
        ...(params.onError !== undefined && { onError: params.onError }),
        ...(params.errorTag !== undefined && { errorTag: params.errorTag }),
      },
      retryLimit: null,
      scheduledAt: null,
      sequence: 0,
    },
  ])

export const drainSystemStepFlowDispatch = (params: {
  readonly dispatchId: string
  readonly queueService: QueueServiceType["Type"]
  readonly flowExecutionOps: FlowExecutionOperations["Type"]
}) =>
  Effect.gen(function* () {
    const jobs = yield* params.flowExecutionOps.queryFlowDispatchJobs(
      params.dispatchId,
    )
    let scheduledFlowId: string | null = null

    for (const job of jobs) {
      yield* params.queueService.enqueue(job.queue, job.payload, {
        logicalJobId: job.logicalJobId,
        ...(job.retryLimit === null ? {} : { retryLimit: job.retryLimit }),
      })
      yield* params.flowExecutionOps.deleteFlowDispatchJob(job.id)

      const candidate = job.payload["scheduledFlowId"]
      if (typeof candidate === "string") {
        scheduledFlowId = candidate
      }
    }

    return scheduledFlowId
  }).pipe(
    Effect.mapError(
      (cause) =>
        new SystemStepFlowDispatchError({
          message: `Failed to dispatch pending system-step flow for ${params.dispatchId}`,
          cause,
        }),
    ),
  )

export const recoverTodoSystemStepFlowDispatch = (todoId: string) =>
  Effect.gen(function* () {
    const queueService = yield* QueueService
    if (queueService.queueInTransaction) return false

    const flowExecutionOps = yield* FlowExecutionOperations
    const scheduledFlowId = yield* drainSystemStepFlowDispatch({
      dispatchId: systemStepTodoDispatchId(todoId),
      queueService,
      flowExecutionOps,
    })
    return scheduledFlowId !== null
  })
