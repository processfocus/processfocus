"use client"

import { createContext, useContext } from "react"
import type { CalendarSlotFieldItem } from "@pf/shadcn-components"

export interface LookupSuggestion {
  readonly value: string
  readonly label: string
}

export type CalendarSlotItem = CalendarSlotFieldItem

export interface LookupOptions {
  readonly todoId?: string
}

/**
 * Service interface for fetching lookup suggestions.
 * Implemented by the frontend to call the GraphQL lookupSuggestions query.
 */
export interface LookupService {
  /** Fetch suggestions via the generic `lookupSuggestions` query. */
  readonly fetchSuggestions: (
    stepPath: string,
    field: string,
    filter: string,
    limit: number,
    options?: LookupOptions,
  ) => Promise<LookupSuggestion[]>

  /**
   * Fetch suggestions via a typed per-lookup query (dependent lookups).
   * `queryName` is the generated GraphQL query name.
   * `variables` contains `filter`, `limit`, and dependency values.
   */
  readonly fetchDependentSuggestions: (
    queryName: string,
    variables: Record<string, unknown>,
  ) => Promise<LookupSuggestion[]>

  readonly fetchCalendarSlots: (
    stepPath: string,
    field: string,
    options?: LookupOptions,
  ) => Promise<CalendarSlotItem[]>
}

const LookupContext = createContext<LookupService | null>(null)

export const LookupProvider = LookupContext.Provider

export function useLookup(): LookupService {
  const ctx = useContext(LookupContext)
  if (!ctx) {
    throw new Error("LookupProvider is required for lookup fields")
  }
  return ctx
}
