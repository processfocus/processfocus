import { usesAppSyncEvents } from "@pf/frontend-endpoints"

const DEPLOYED_EVENT_WAIT_MS = 60_000

// Flow completion does not wait for the separate SQS/AppSync publication jobs.
// Keep the subscription alive through their lag instead of retrying the scenario.
export const websocketEventWaitMs = (localWaitMs = 10_000): number =>
  usesAppSyncEvents() ? DEPLOYED_EVENT_WAIT_MS : localWaitMs

// Cucumber must let the inner wait finish and report its received-event details.
export const WEBSOCKET_STEP_TIMEOUT_MS = DEPLOYED_EVENT_WAIT_MS + 10_000
