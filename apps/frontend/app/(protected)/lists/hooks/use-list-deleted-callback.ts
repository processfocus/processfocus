"use client"

import { useQueryClient } from "@tanstack/react-query"
import { useCallback } from "react"
import { useListRefresh } from "@/app/(protected)/lists/lib/list-refresh-provider"

/**
 * Hook that returns a callback to refresh item and list state after deletion.
 */
export function useListDeletedCallback(listPath: string, itemId: string) {
  const queryClient = useQueryClient()
  const refreshState = useListRefresh()

  return useCallback(() => {
    queryClient.invalidateQueries({
      queryKey: ["listItem", listPath, itemId],
    })
    refreshState.invalidate(listPath)
  }, [queryClient, listPath, itemId, refreshState])
}
