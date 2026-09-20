export type DeployProgressStatus = "progress" | "completed" | "failed"

export interface DeployProgressEvent {
  readonly version: 1
  readonly executionId: string
  readonly phase: string
  readonly status: DeployProgressStatus
  readonly message: string
  readonly timestamp: string
}

export interface DeployProgressEventSource
  extends AsyncIterable<DeployProgressEvent> {
  readonly close: () => Promise<void>
}

export interface DeployProgressEventSourceConfig {
  readonly realtimeUrl: string
  readonly appSyncEventsHttpHost: string
  readonly accessToken: string
  readonly channel: string
}
