"use client"

import { useQueryClient } from "@tanstack/react-query"
import { useRouter } from "next/navigation"
import { useCallback } from "react"
import { markListStale } from "../lib/list-refresh"

/**
 * Hook that returns a callback to refresh item and list state after deletion.
 */
export function useListDeletedCallback(listPath: string, itemId: string) {
  const queryClient = useQueryClient()
  const router = useRouter()

  return useCallback(() => {
    queryClient.invalidateQueries({
      queryKey: ["listItem", listPath, itemId],
    })
    markListStale(listPath)
    router.refresh()
  }, [queryClient, listPath, itemId, router])
}
