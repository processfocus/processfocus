"use client"

import { type ReactNode, useCallback, useMemo } from "react"
import {
  LookupProvider as BaseLookupProvider,
  type CalendarSlotItem,
  type LookupOptions,
  type LookupService,
  type LookupSuggestion,
} from "@pf/form/lookup-context"
import { useGraphqlClient } from "./client-provider"
import { fetchDependentLookupSuggestions } from "./dependent-lookup-query"
import { CALENDAR_SLOTS_QUERY, LOOKUP_SUGGESTIONS_QUERY } from "./queries"

interface LookupSuggestionsResponse {
  lookupSuggestions: Array<{
    value: string
    label: string
  }>
}

interface CalendarSlotsResponse {
  calendarSlots: CalendarSlotItem[]
}

export function LookupClientProvider({ children }: { children: ReactNode }) {
  const graphqlClient = useGraphqlClient()

  const fetchSuggestions = useCallback(
    async (
      stepPath: string,
      field: string,
      filter: string,
      limit: number,
      options?: LookupOptions,
    ): Promise<LookupSuggestion[]> => {
      const data = await graphqlClient.request<LookupSuggestionsResponse>(
        LOOKUP_SUGGESTIONS_QUERY,
        { stepPath, field, filter, limit, todoId: options?.todoId },
      )
      return data.lookupSuggestions
    },
    [graphqlClient],
  )

  const fetchDependentSuggestions = useCallback(
    async (
      queryName: string,
      variables: Record<string, unknown>,
    ): Promise<LookupSuggestion[]> => {
      return fetchDependentLookupSuggestions(
        graphqlClient,
        queryName,
        variables,
      )
    },
    [graphqlClient],
  )

  const fetchCalendarSlots = useCallback(
    async (
      stepPath: string,
      field: string,
      options?: LookupOptions,
    ): Promise<CalendarSlotItem[]> => {
      const data = await graphqlClient.request<CalendarSlotsResponse>(
        CALENDAR_SLOTS_QUERY,
        { stepPath, field, todoId: options?.todoId },
      )
      return data.calendarSlots
    },
    [graphqlClient],
  )

  const service = useMemo<LookupService>(
    () => ({ fetchSuggestions, fetchDependentSuggestions, fetchCalendarSlots }),
    [fetchSuggestions, fetchDependentSuggestions, fetchCalendarSlots],
  )

  return <BaseLookupProvider value={service}>{children}</BaseLookupProvider>
}
