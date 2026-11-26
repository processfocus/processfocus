import type { Job } from "@processfocus/runtime"

export { FLOW_EXECUTION_QUEUE } from "@pf/graphql-db-operations"

import {
  type FlowExecutionPayload,
  FlowExecutionPayloadSchema,
  advanceScheduledFlow,
} from "@pf/process-execution/worker"

export { type FlowExecutionPayload, FlowExecutionPayloadSchema }

export const flowExecutionHandler = {
  schema: FlowExecutionPayloadSchema,
  handle: (
    job: Job<FlowExecutionPayload>,
  ): ReturnType<typeof advanceScheduledFlow> =>
    advanceScheduledFlow({
      jobId: job.jobId,
      payload: job.payload,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
    }),
}
