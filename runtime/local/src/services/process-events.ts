import { ProcessEvents } from "@pf/graphql-api"
import { createEventHubLayer } from "./event-hub"

/**
 * Live implementation using in-memory event broadcasting.
 *
 * This implementation can only handle as many subscribers as there is
 * memory, and it will require subscribers to resubscribe on
 * restart. For the target use case that is sufficient.
 */
export const ProcessEventsLive = createEventHubLayer(ProcessEvents)
