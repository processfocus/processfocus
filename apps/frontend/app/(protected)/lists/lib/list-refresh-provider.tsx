"use client"

import { useRouter, useSearchParams } from "next/navigation"
import { type ReactNode, createContext, useContext, useState } from "react"
import { ListRefreshState, parseListReturnDestination } from "./list-refresh"
import { useSession } from "@/components/auth-provider"
import { useRuntimeConfig } from "@/components/config-provider"
import { getSessionCacheScope } from "@/lib/auth/session-cache-scope"

const ListRefreshContext = createContext<ListRefreshState | null>(null)

export function ListRefreshProvider({ children }: { children: ReactNode }) {
  const session = useSession()
  const { orgId, graphqlEndpoint } = useRuntimeConfig()
  const scope = JSON.stringify([
    orgId,
    graphqlEndpoint,
    getSessionCacheScope(session),
  ])
  return (
    <ScopedListRefreshProvider key={scope}>
      {children}
    </ScopedListRefreshProvider>
  )
}

function ScopedListRefreshProvider({ children }: { children: ReactNode }) {
  const [state] = useState(() => new ListRefreshState())
  return (
    <ListRefreshContext.Provider value={state}>
      {children}
    </ListRefreshContext.Provider>
  )
}

export function useListRefresh(): ListRefreshState {
  const state = useContext(ListRefreshContext)
  if (!state) throw new Error("ListRefreshProvider is required")
  return state
}

/** Both process routes share the success/cancellation and warm-history contract. */
export function useReturnToList(retainList = false) {
  const router = useRouter()
  const params = useSearchParams()
  const state = useListRefresh()
  return (result: "submitted" | "cancelled"): boolean => {
    const destination = parseListReturnDestination(
      params.get("returnTo"),
      window.location.origin,
    )
    if (!destination) return false
    const { href, listPath } = destination
    if (result === "submitted") state.invalidate(listPath)
    if (state.canReturn(params.get("listReturn"), href)) {
      router.back()
    } else if (retainList) {
      window.history.replaceState(null, "", href)
    } else {
      // A direct/reloaded form has no retained shell. Load the normal SSR route.
      router.push(href)
    }
    return true
  }
}
