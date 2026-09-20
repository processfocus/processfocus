"use client"

import { useQueryClient } from "@tanstack/react-query"
import { useEffect, useEffectEvent } from "react"
import type { ImportCompletedPayload } from "./import-completed-events"
import {
  invalidateImportCompletedQueries,
  refreshImportCompletedCollections,
} from "./import-completed-refresh"
import { useSession } from "@/components/auth-provider"
import { useRuntimeConfig } from "@/components/config-provider"

const parseImportCompletedPayload = (
  data: string,
): ImportCompletedPayload | null => {
  const payload = JSON.parse(data) as { processPaths?: unknown }

  if (!Array.isArray(payload.processPaths)) {
    return null
  }

  return {
    processPaths: payload.processPaths.filter(
      (path): path is string => typeof path === "string",
    ),
  }
}

export function DevImportCompletedQueryInvalidation() {
  const queryClient = useQueryClient()
  const runtimeConfig = useRuntimeConfig()
  const session = useSession()

  const handleMessage = useEffectEvent((event: MessageEvent<string>) => {
    let payload: ImportCompletedPayload | null
    try {
      payload = parseImportCompletedPayload(event.data)
    } catch {
      return
    }

    if (payload) {
      void invalidateImportCompletedQueries(queryClient, payload)
      void refreshImportCompletedCollections(
        runtimeConfig,
        session.userId,
        payload,
      )
    }
  })

  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return

    const events = new EventSource("/api/dev/import-events")
    events.onmessage = handleMessage

    return () => events.close()
  }, [])

  return null
}
