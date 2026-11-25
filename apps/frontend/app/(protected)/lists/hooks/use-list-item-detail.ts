"use client"

import { useQuery } from "@tanstack/react-query"
import { useSearchParams } from "next/navigation"
import { useEffect, useMemo, useState } from "react"
import {
  collectMetricControlUrlState,
  keepPreviousMetricDetail,
} from "./metric-control-url-state"
import { useSession } from "@/components/auth-provider"
import { getActiveRoleCacheKey } from "@/lib/auth/session-role"
import { loadBrowserFormDefinition } from "@/lib/frontend-form-loaders"
import { useGraphqlClient } from "@/lib/graphql/client-provider"
import {
  fetchAvailableLists,
  fetchListFormMetadata,
} from "@/lib/graphql/list-queries"
import { listDetailSelection } from "@/lib/list-detail-selection"

/**
 * Shared hook for fetching list item detail data.
 * Used by both the full-page and modal detail views.
 */
export function useListItemDetail(listPath: string, itemId: string) {
  const searchParams = useSearchParams()
  const client = useGraphqlClient()
  const session = useSession()
  const currentRole = getActiveRoleCacheKey(session)
  const searchParamsKey = searchParams.toString()
  const [controlSearch, setControlSearch] = useState(searchParamsKey)

  useEffect(() => {
    const handleControlChange = () => {
      setControlSearch(window.location.search)
    }

    window.addEventListener(
      "metric-breakdown-control-change",
      handleControlChange,
    )
    return () => {
      window.removeEventListener(
        "metric-breakdown-control-change",
        handleControlChange,
      )
    }
  }, [])

  useEffect(() => {
    setControlSearch(searchParamsKey)
  }, [searchParamsKey])

  // Fetch list metadata to get the query name
  const {
    data: availableLists,
    isLoading: listsLoading,
    isFetching: listsFetching,
    error: listsError,
    refetch: refetchLists,
  } = useQuery({
    queryKey: ["availableLists", session.userId, currentRole],
    queryFn: () => fetchAvailableLists(client),
    staleTime: 60 * 1000,
  })

  const currentList = useMemo(() => {
    if (!availableLists || !listPath) return null
    return availableLists.find((l) => l.path === listPath) ?? null
  }, [availableLists, listPath])

  const {
    data: formMetadata,
    isLoading: formMetadataLoading,
    isFetching: metadataFetching,
    isFetched: formMetadataFetched,
    error: formMetadataError,
    refetch: refetchMetadata,
  } = useQuery({
    queryKey: ["listFormMetadata", listPath, session.userId, currentRole],
    queryFn: () => fetchListFormMetadata(client, listPath),
    enabled: !!currentList?.itemQueryName,
    staleTime:
      process.env["NODE_ENV"] === "development" ? 0 : Number.POSITIVE_INFINITY,
    gcTime:
      process.env["NODE_ENV"] === "development" ? 0 : Number.POSITIVE_INFINITY,
  })

  const formComponents = null

  const {
    data: fieldsSelection = "",
    isLoading: schemaLoading,
    isFetching: schemaFetching,
    error: schemaError,
    refetch: refetchSchema,
  } = useQuery({
    queryKey: ["listDetailSelection", listPath],
    queryFn: async () =>
      listDetailSelection(await loadBrowserFormDefinition(`${listPath}/edit`)),
    enabled: !!currentList?.itemQueryName,
    staleTime: Number.POSITIVE_INFINITY,
  })
  const metricControlUrlState = useMemo(
    () =>
      collectMetricControlUrlState(
        formComponents,
        new URLSearchParams(controlSearch),
      ),
    [controlSearch],
  )
  const metricControlValues = metricControlUrlState.values
  const metricControlValuesKey = JSON.stringify(metricControlValues)
  const hasEmptyItemSelection =
    !!currentList?.itemQueryName &&
    formMetadataFetched &&
    !schemaLoading &&
    !schemaError &&
    fieldsSelection.length === 0

  useEffect(() => {
    if (!metricControlUrlState.normalized) return

    const url = new URL(window.location.href)
    url.search = metricControlUrlState.search
    window.history.replaceState(null, "", url)
    setControlSearch(url.search)
  }, [metricControlUrlState.normalized, metricControlUrlState.search])

  useEffect(() => {
    if (!hasEmptyItemSelection) return

    console.warn("Skipping list item detail query with no selected fields", {
      itemQueryName: currentList?.itemQueryName,
      listPath,
    })
  }, [currentList?.itemQueryName, hasEmptyItemSelection, listPath])

  const {
    data: itemDetail,
    isLoading: itemLoading,
    isFetching: itemFetching,
    error,
    refetch,
  } = useQuery({
    queryKey: [
      "listItem",
      listPath,
      itemId,
      fieldsSelection,
      metricControlValuesKey,
      session.userId,
      currentRole,
    ],
    queryFn: async () => {
      if (!currentList?.itemQueryName || !fieldsSelection) return null

      // Build the GraphQL query dynamically using the itemQueryName
      // Use GraphQL variables to prevent injection attacks
      const itemQueryName = currentList.itemQueryName

      const controlEntries = Object.entries(metricControlValues)
      const controlDefinitions = controlEntries
        .map(([name]) => `$${name}: String`)
        .join(", ")
      const controlArguments = controlEntries
        .map(([name]) => `${name}: $${name}`)
        .join(", ")
      const variableDefinitions = [`$id: String!`, controlDefinitions]
        .filter(Boolean)
        .join(", ")
      const argumentsList = [`id: $id`, controlArguments]
        .filter(Boolean)
        .join(", ")

      const query = `
        query ItemDetail(${variableDefinitions}) {
          ${itemQueryName}(${argumentsList}) {
            ${fieldsSelection}
          }
        }
      `

      const result = await client.request<
        Record<string, Record<string, unknown> | null>
      >(query, { id: itemId, ...metricControlValues })
      return result[itemQueryName] ?? null
    },
    placeholderData: keepPreviousMetricDetail,
    enabled:
      !!currentList?.itemQueryName &&
      formMetadataFetched &&
      fieldsSelection.length > 0,
  })

  const isLoading =
    listsLoading ||
    formMetadataLoading ||
    schemaLoading ||
    itemLoading ||
    !!(listsError && listsFetching) ||
    !!(formMetadataError && metadataFetching) ||
    !!(schemaError && schemaFetching) ||
    !!(error && itemFetching)

  return {
    currentList,
    formMetadata,
    itemDetail,
    isLoading,
    error: listsError ?? formMetadataError ?? schemaError ?? error,
    refetch: () => {
      if (listsError) return refetchLists()
      if (formMetadataError) return refetchMetadata()
      if (schemaError) return refetchSchema()
      return refetch()
    },
  }
}
