"use client"

import type {
  GraphqlClientConsumerProps,
  GraphqlRequester,
} from "@pf/frontend-plugin-host"
import { useOptionalGraphqlClient } from "./client-provider"

const publicGraphqlRequester: GraphqlRequester = {
  request: async (): Promise<never> => {
    throw new Error(
      "Authenticated GraphQL requests are unavailable on this public surface",
    )
  },
}

export function GraphqlClientConsumer({
  children,
}: GraphqlClientConsumerProps) {
  const graphqlClient = useOptionalGraphqlClient()

  return children(graphqlClient ?? publicGraphqlRequester)
}
