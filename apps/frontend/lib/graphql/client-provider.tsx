"use client"

import { GraphQLClient } from "graphql-request"
import { type ReactNode, createContext, useContext, useMemo } from "react"
import { useRuntimeConfig } from "@/components/config-provider"
import { useActiveFrontendClientPlugins } from "@/components/frontend-client-plugin-provider"
import {
  extractGraphqlRequestDocument,
  reportGraphqlRequestError,
} from "@/lib/graphql/client-error-reporting"

const GraphqlClientContext = createContext<GraphQLClient | null>(null)

export function GraphqlClientProvider({ children }: { children: ReactNode }) {
  const { graphqlEndpoint } = useRuntimeConfig()
  const activePlugins = useActiveFrontendClientPlugins()

  const client = useMemo(() => {
    const graphqlClient = new GraphQLClient(graphqlEndpoint, {
      credentials: "include",
    })

    const originalRequest = graphqlClient.request.bind(graphqlClient)

    graphqlClient.request = (async (...args: unknown[]) => {
      try {
        return await (
          originalRequest as (...requestArgs: unknown[]) => Promise<unknown>
        )(...args)
      } catch (error) {
        const document = extractGraphqlRequestDocument(args[0])
        reportGraphqlRequestError(activePlugins, document, error)
        throw error
      }
    }) as GraphQLClient["request"]

    return graphqlClient
  }, [activePlugins, graphqlEndpoint])

  return (
    <GraphqlClientContext.Provider value={client}>
      {children}
    </GraphqlClientContext.Provider>
  )
}

export function useOptionalGraphqlClient(): GraphQLClient | null {
  return useContext(GraphqlClientContext)
}

export function useGraphqlClient(): GraphQLClient {
  const client = useOptionalGraphqlClient()
  if (!client) {
    throw new Error(
      "useGraphqlClient must be used within GraphqlClientProvider",
    )
  }
  return client
}
