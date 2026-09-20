import { QueryClient } from "@tanstack/react-query"

// Create a new QueryClient with default options
const makeQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60 * 1000, // 1 minute
        refetchOnWindowFocus: false,
      },
    },
  })

// Browser-only singleton QueryClient
let browserQueryClient: QueryClient | undefined
let browserSessionScope: string | undefined

/**
 * Get or create a QueryClient singleton
 * - Server: always creates a new client for each request
 * - Browser: reuses the same client across navigations
 *
 * IMPORTANT: Always use this function instead of importing a singleton.
 * This ensures proper server/client separation in Next.js.
 */
export const getQueryClient = (sessionScope?: string) => {
  if (typeof window === "undefined") {
    // Server: always make a new query client for each request
    return makeQueryClient()
  } else {
    if (sessionScope !== undefined && sessionScope !== browserSessionScope) {
      browserQueryClient?.clear()
      browserQueryClient = undefined
      browserSessionScope = sessionScope
    }
    // Browser: make a new query client if we don't already have one
    // This ensures we reuse the same client across client-side navigations
    if (!browserQueryClient) browserQueryClient = makeQueryClient()
    return browserQueryClient
  }
}
