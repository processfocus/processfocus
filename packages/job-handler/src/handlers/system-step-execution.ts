import type { Job } from "@processfocus/runtime"

export { SYSTEM_STEP_EXECUTION_QUEUE } from "@pf/graphql-db-operations"

import {
  type SystemStepExecutionPayload,
  SystemStepExecutionPayloadSchema,
  executeSystemStep,
} from "@pf/process-execution/worker"

export { type SystemStepExecutionPayload, SystemStepExecutionPayloadSchema }

export const systemStepExecutionHandler = {
  schema: SystemStepExecutionPayloadSchema,
  handle: (
    job: Job<SystemStepExecutionPayload>,
  ): ReturnType<typeof executeSystemStep> =>
    executeSystemStep({
      jobId: job.jobId,
      payload: job.payload,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
    }),
}
