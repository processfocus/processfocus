import type { QueryClient } from "@tanstack/react-query"
import type { ImportCompletedPayload } from "./import-completed-events"
import { recreateAllReplications } from "@/lib/collections/replication-registry"

export const formMetadataQueryKey = ["formMetadata"] as const

export const invalidateImportCompletedQueries = (
  queryClient: QueryClient,
  payload: ImportCompletedPayload,
) => {
  if (payload.processPaths.length === 0) {
    return Promise.resolve()
  }

  return queryClient.invalidateQueries({
    queryKey: formMetadataQueryKey,
    refetchType: "active",
  })
}

export const refreshImportCompletedCollections = async (
  runtimeConfig: {
    readonly appSyncEventsHttpEndpoint: string
    readonly graphqlEndpoint: string
    readonly wsEndpoint: string
  },
  userId: string,
  payload: ImportCompletedPayload,
) => {
  if (payload.processPaths.length === 0) {
    return { success: true, errors: [] }
  }

  return recreateAllReplications({
    appSyncEventsHttpEndpoint: runtimeConfig.appSyncEventsHttpEndpoint,
    graphqlEndpoint: runtimeConfig.graphqlEndpoint,
    userId,
    wsEndpoint: runtimeConfig.wsEndpoint,
  })
}
