"use client"

import { type Collection, eq } from "@tanstack/db"
import { useLiveQuery } from "@tanstack/react-db"
import { use, useCallback, useEffect, useRef, useState } from "react"
import type { ProcessDocType } from "@/lib/collections/process-collection-provider"
import { useProcessCollection } from "@/lib/collections/process-collection-provider"
import type { ProcessWorkflowQuery } from "@/lib/generated/gql/graphql"
import { useGraphqlClient } from "@/lib/graphql/client-provider"
import { processWorkflowQuery } from "@/lib/graphql/workflow-queries"

type WorkflowData = NonNullable<ProcessWorkflowQuery["processWorkflow"]>

type ImportCompletedEvent = {
  readonly processPaths?: readonly string[]
}

/**
 * Watches the RxDB process collection for changes to a specific process.
 * When updatedAt changes, re-fetches the processWorkflow query via client-side GraphQL.
 * Returns the latest workflow data, starting with server-provided initial data.
 */
export function useWorkflowAutoRefresh(
  processPath: string,
  initialData: WorkflowData,
): { workflowData: WorkflowData; isRefreshing: boolean; refreshCount: number } {
  const [workflowData, setWorkflowData] = useState<WorkflowData>(initialData)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [refreshCount, setRefreshCount] = useState(0)
  const lastUpdatedAtRef = useRef<number | null>(null)
  const workflowJsonRef = useRef(JSON.stringify(initialData))
  const graphqlClient = useGraphqlClient()

  // Watch process collection for the specific process by path
  const { collectionPromise } = useProcessCollection()
  const processesCollection = use(collectionPromise)
  const processQuery = useProcessLiveQuery(processesCollection, processPath)

  const refetch = useCallback(
    async (trackRefreshing = true) => {
      if (trackRefreshing) {
        setIsRefreshing(true)
      }
      try {
        const data = await graphqlClient.request(processWorkflowQuery, {
          processPath,
        })
        if (data.processWorkflow) {
          const nextWorkflowJson = JSON.stringify(data.processWorkflow)
          if (nextWorkflowJson !== workflowJsonRef.current) {
            workflowJsonRef.current = nextWorkflowJson
            setWorkflowData(data.processWorkflow)
            setRefreshCount((c) => c + 1)
          }
        }
      } catch (error) {
        console.error("Failed to refetch workflow data:", error)
      }
      if (trackRefreshing) {
        setIsRefreshing(false)
      }
    },
    [graphqlClient, processPath],
  )

  // Track updatedAt changes and trigger refetch
  useEffect(() => {
    const process = processQuery.data?.[0]
    if (!process) return

    const currentUpdatedAt = process.updatedAt
    if (
      lastUpdatedAtRef.current !== null &&
      currentUpdatedAt !== lastUpdatedAtRef.current
    ) {
      void refetch()
    }
    lastUpdatedAtRef.current = currentUpdatedAt
  }, [processQuery.data, refetch])

  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return

    const events = new EventSource("/api/dev/import-events")
    events.onmessage = (event) => {
      let payload: ImportCompletedEvent
      try {
        payload = JSON.parse(event.data) as ImportCompletedEvent
      } catch {
        return
      }
      if (payload.processPaths?.includes(processPath)) {
        void refetch(false)
      }
    }

    return () => events.close()
  }, [processPath, refetch])

  return { workflowData, isRefreshing, refreshCount }
}

/**
 * Live query for a single process by path.
 */
const useProcessLiveQuery = (
  collection: Collection<ProcessDocType, string>,
  processPath: string,
) => {
  return useLiveQuery((q) =>
    q
      .from({ process: collection })
      .where(({ process }) => eq(process.path, processPath))
      .select(({ process }) => ({
        id: process.id,
        updatedAt: process.updatedAt,
        path: process.path,
      })),
  )
}
