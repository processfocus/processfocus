import {
  getGraphqlEndpoint as getGraphqlEndpointBase,
  getWsEndpoint as getWsEndpointBase,
} from "@pf/frontend-endpoints"

const isDevelopment = process.env["NODE_ENV"] === "development"

export const getGraphqlEndpoint = (): string => {
  if (isDevelopment) {
    // Dynamic require to avoid static analysis by file tracer
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const portFiles = require("@pf/frontend-endpoints/port-files")
    return portFiles.getEffectiveGraphqlEndpoint()
  }
  return getGraphqlEndpointBase()
}

export const getWsEndpoint = (): string => {
  if (isDevelopment) {
    // Dynamic require to avoid static analysis by file tracer
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const portFiles = require("@pf/frontend-endpoints/port-files")
    return portFiles.getEffectiveWsEndpoint()
  }
  return getWsEndpointBase()
}
