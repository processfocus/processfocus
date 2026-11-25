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
import {
  CALENDAR_SLOTS_QUERY,
  LOOKUP_SEARCH_QUERY,
  LOOKUP_SELECTION_QUERY,
  LOOKUP_SUGGESTIONS_QUERY,
} from "./queries"

interface LookupSuggestionsResponse {
  lookupSuggestions: Array<{
    value: string
    label: string
    searchText?: string | null
  }>
}

interface CalendarSlotsResponse {
  calendarSlots: CalendarSlotItem[]
}

export function LookupClientProvider({
  children,
  listCreate,
}: {
  children: ReactNode
  listCreate?: boolean
}) {
  const graphqlClient = useGraphqlClient()

  const fetchSuggestions = useCallback(
    async (
      stepPath: string,
      field: string,
      filter: string,
      limit: number,
      options?: LookupOptions,
    ): Promise<LookupSuggestion[]> => {
      const request = async (search: string, count: number) => {
        const data = await graphqlClient.request<LookupSuggestionsResponse>(
          LOOKUP_SUGGESTIONS_QUERY,
          {
            stepPath,
            field,
            filter: search,
            limit: count,
            todoId: options?.todoId,
            listCreate,
          },
        )
        return data.lookupSuggestions.map(({ value, label, searchText }) => ({
          value,
          label,
          ...(searchText != null && { searchText }),
        }))
      }
      return request(filter, limit)
    },
    [graphqlClient, listCreate],
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

  const fetchPrefill = useCallback(
    async (queryName: string, value: string): Promise<unknown> => {
      if (!/^[_A-Za-z][_0-9A-Za-z]*$/.test(queryName))
        throw new Error("Invalid prefill query")
      const data = await graphqlClient.request<Record<string, unknown>>(
        `query Prefill($value: String!) { ${queryName}(value: $value) }`,
        { value },
      )
      return data[queryName]
    },
    [graphqlClient],
  )

  const service = useMemo<LookupService>(
    () => ({
      resolveSelection: async (stepPath, field, value, options) => {
        const data = await graphqlClient.request(LOOKUP_SELECTION_QUERY, {
          stepPath,
          field,
          value,
          todoId: options?.todoId,
          listCreate,
        })
        return data.lookupSelection ?? null
      },
      search: async (stepPath, field, filter, limit, options) => {
        const data = await graphqlClient.request(LOOKUP_SEARCH_QUERY, {
          stepPath,
          field,
          filter,
          limit,
          todoId: options?.todoId,
          listCreate,
        })
        return data.lookupSearch
      },
      fetchSuggestions,
      fetchDependentSuggestions,
      fetchCalendarSlots,
      fetchPrefill,
    }),
    [
      graphqlClient,
      listCreate,
      fetchSuggestions,
      fetchDependentSuggestions,
      fetchCalendarSlots,
      fetchPrefill,
    ],
  )

  return <BaseLookupProvider value={service}>{children}</BaseLookupProvider>
}
