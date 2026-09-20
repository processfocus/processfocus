import "server-only"
import { getAppSyncEventsHttpHost } from "@pf/frontend-endpoints"
import { getGraphqlEndpoint, getWsEndpoint } from "./graphql/endpoint"

export type RuntimeConfig = {
  graphqlEndpoint: string
  wsEndpoint: string
  appSyncEventsHttpEndpoint: string
  orgId: string
  featureFlags: {
    newDashboard: boolean
  }
}

export const getRuntimeConfig = (orgId: string): RuntimeConfig => ({
  graphqlEndpoint: getGraphqlEndpoint(),
  wsEndpoint: getWsEndpoint(),
  appSyncEventsHttpEndpoint: getAppSyncEventsHttpHost() ?? "",
  orgId,
  featureFlags: {
    newDashboard: false,
  },
})
