"use client"

import { useQueryClient } from "@tanstack/react-query"
import { usePathname } from "next/navigation"
import {
  type ReactNode,
  createContext,
  useContext,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react"
import type { ImportCompletedPayload } from "./import-completed-events"
import {
  invalidateImportCompletedQueries,
  refreshImportCompletedCollections,
} from "./import-completed-refresh"
import { parseListReturnDestination } from "@/app/(protected)/lists/lib/list-refresh"
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

const ImportRevision = createContext<string | null>(null)

export const useDevImportRevision = () => useContext(ImportRevision)

export function DevImportCompletedProvider({
  children,
}: {
  children: ReactNode
}) {
  const queryClient = useQueryClient()
  const runtimeConfig = useRuntimeConfig()
  const session = useSession()
  const pathname = usePathname()
  const deferredProcessImport = useRef<ImportCompletedPayload | null>(null)
  const lastEventId = useRef<string | null>(null)
  const [revision, setRevision] = useState<string | null>(null)
  const refreshImport = useEffectEvent((payload: ImportCompletedPayload) => {
    void invalidateImportCompletedQueries(queryClient, payload)
    void refreshImportCompletedCollections(
      runtimeConfig,
      session.userId,
      payload,
    )
  })

  // Refetching form defaults or recreating draft replication can reset inputs in a
  // retained List's process dialog. Apply the latest import after leaving the form.
  useEffect(() => {
    if (
      !pathname.startsWith("/processes/start/") &&
      deferredProcessImport.current
    ) {
      refreshImport(deferredProcessImport.current)
      deferredProcessImport.current = null
    }
  }, [pathname])

  const handleMessage = useEffectEvent((event: MessageEvent<string>) => {
    let payload: ImportCompletedPayload | null
    try {
      payload = parseImportCompletedPayload(event.data)
    } catch {
      return
    }

    if (payload) {
      if (event.lastEventId) {
        if (event.lastEventId === lastEventId.current) return
        // The first receipt establishes the baseline for this connection.
        if (lastEventId.current !== null) setRevision(event.lastEventId)
        lastEventId.current = event.lastEventId
      }
      const url = new URL(window.location.href)
      if (
        payload.processPaths.length &&
        url.pathname.startsWith("/processes/start/") &&
        parseListReturnDestination(url.searchParams.get("returnTo"), url.origin)
      ) {
        deferredProcessImport.current = payload
        void invalidateImportCompletedQueries(queryClient, { processPaths: [] })
      } else {
        refreshImport(payload)
      }
    }
  })

  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return

    const events = new EventSource("/api/dev/import-events")
    events.onmessage = handleMessage

    return () => events.close()
  }, [])

  return (
    <ImportRevision.Provider value={revision}>
      {children}
    </ImportRevision.Provider>
  )
}
