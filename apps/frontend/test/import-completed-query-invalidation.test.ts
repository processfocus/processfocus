import { QueryClient } from "@tanstack/react-query"
import { beforeEach, describe, expect, test, vi } from "vitest"
import {
  clearReplicationRegistry,
  registerReplication,
} from "../lib/collections/replication-registry"
import {
  formMetadataQueryKey,
  invalidateImportCompletedQueries,
  refreshImportCompletedCollections,
} from "../lib/dev/import-completed-refresh"

describe("import-completed query invalidation", () => {
  beforeEach(() => {
    clearReplicationRegistry()
  })

  test("invalidates active form metadata queries after import completes", async () => {
    const queryClient = new QueryClient()
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries")

    await invalidateImportCompletedQueries(queryClient, {
      processPaths: ["/enrolment-enquiry"],
    })

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: formMetadataQueryKey,
      refetchType: "active",
    })
  })

  test("ignores empty import payloads", async () => {
    const queryClient = new QueryClient()
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries")

    await invalidateImportCompletedQueries(queryClient, { processPaths: [] })

    expect(invalidateQueries).not.toHaveBeenCalled()
  })

  test("recreates active replications after import completes", async () => {
    const recreateReplication = vi.fn()
    registerReplication("Todo", recreateReplication, async () => {})

    await refreshImportCompletedCollections(
      {
        appSyncEventsHttpEndpoint: "",
        graphqlEndpoint: "http://localhost:4000/graphql",
        wsEndpoint: "ws://localhost:4000/graphql",
      },
      "usr-1",
      { processPaths: ["/enrolment-enquiry"] },
    )

    expect(recreateReplication).toHaveBeenCalledWith({
      appSyncEventsHttpEndpoint: "",
      graphqlEndpoint: "http://localhost:4000/graphql",
      userId: "usr-1",
      wsEndpoint: "ws://localhost:4000/graphql",
    })
  })

  test("does not recreate replications for empty import payloads", async () => {
    const recreateReplication = vi.fn()
    registerReplication("Todo", recreateReplication, async () => {})

    await refreshImportCompletedCollections(
      {
        appSyncEventsHttpEndpoint: "",
        graphqlEndpoint: "http://localhost:4000/graphql",
        wsEndpoint: "ws://localhost:4000/graphql",
      },
      "usr-1",
      { processPaths: [] },
    )

    expect(recreateReplication).not.toHaveBeenCalled()
  })
})
