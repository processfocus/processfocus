/** Execution-relevant facts from an at-least-once delivery. */
export interface ExecutionDelivery<Payload> {
  readonly jobId: string
  readonly payload: Payload
  readonly attempts: number
  readonly maxAttempts: number
}
