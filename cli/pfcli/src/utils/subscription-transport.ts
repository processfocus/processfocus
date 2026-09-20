export const SUBSCRIPTION_TRANSPORT_QUERY = `
  query SubscriptionTransport {
    subscriptionTransport {
      kind
      appSyncEventsHttpHost
    }
  }
`

export interface SubscriptionTransportResponse {
  subscriptionTransport: {
    kind: "GRAPHQL_WS" | "APPSYNC_EVENTS"
    appSyncEventsHttpHost: string | null
  }
}
