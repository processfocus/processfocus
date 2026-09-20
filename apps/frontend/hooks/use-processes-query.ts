import type { Collection } from "@tanstack/db"
import { useLiveQuery } from "@tanstack/react-db"
import { use } from "react"
import {
  type ProcessDocType,
  useProcessCollection,
} from "@/lib/collections/process-collection-provider"

interface UseProcessesQueryResult {
  processes: ProcessDocType[]
  isLoading: boolean
}

/**
 * Shared hook implementation that takes a collection and returns processes query result.
 * Used internally by both useProcessesQuery and useProcessesQueryWithCollection.
 */
const useProcessesLiveQuery = (
  processesCollection: Collection<ProcessDocType, string>,
) => {
  return useLiveQuery((q) =>
    q.from({ process: processesCollection }).select(({ process }) => ({
      id: process.id,
      updatedAt: process.updatedAt,
      name: process.name,
      path: process.path,
      activeInstances: process.activeInstances,
      category: process.category,
      duration: process.duration,
      formFieldCount: process.formFieldCount,
      purpose: process.purpose,
      isFavorite: process.isFavorite,
      orgUnit: process.orgUnit,
      startStepPath: process.startStepPath,
      canSkipScheduleWaits: process.canSkipScheduleWaits,
    })),
  )
}

/**
 * Hook to query all processes from the RxDB collection.
 * Data is kept in sync via RxDB replication.
 *
 * IMPORTANT: This hook uses React's use() to suspend until the collection is ready.
 * Components using this hook MUST be wrapped in a Suspense boundary.
 */
export const useProcessesQuery = (): UseProcessesQueryResult => {
  const { collectionPromise } = useProcessCollection()
  const processesCollection = use(collectionPromise)
  const processesQuery = useProcessesLiveQuery(processesCollection)

  return {
    processes: processesQuery.data ?? [],
    isLoading: !processesQuery.isReady,
  }
}
