"use client"

import { useQuery } from "@tanstack/react-query"
import { useSearchParams } from "next/navigation"
import { useEffect, useMemo, useState } from "react"
import type { FormComponent } from "@pf/form-client-representation/types"
import { FormComponentType } from "@pf/form-client-representation/types"
import {
  collectMetricControlUrlState,
  isGraphqlName,
  keepPreviousMetricDetail,
} from "./metric-control-url-state"
import { useSession } from "@/components/auth-provider"
import { getActiveRoleCacheKey } from "@/lib/auth/session-role"
import { useGraphqlClient } from "@/lib/graphql/client-provider"
import {
  fetchAvailableLists,
  fetchListFormMetadata,
} from "@/lib/graphql/list-queries"

// Keep this selection aligned with MetricBreakdownData in @pf/form-schema.
const metricBreakdownSelection = (field: string) => `${field} {
              total
              currency
              badge
              fields {
                label
                value
              }
              buckets {
                label
                amount
                description
                color
              }
            }`

const addSelection = (
  selections: Map<string, string>,
  field: string,
  selection: string = field,
) => {
  if (isGraphqlName(field) && !selections.has(field)) {
    selections.set(field, selection)
  }
}

const selectionFieldName = (field: string) =>
  field.includes(".") ? field.slice(field.lastIndexOf(".") + 1) : field

const addItemComponentSelection = (
  selections: Map<string, string>,
  component: FormComponent,
) => {
  switch (component._tag) {
    case FormComponentType.FieldSet:
      Object.values(component.children).forEach((child) => {
        addItemComponentSelection(selections, child)
      })
      return

    case FormComponentType.Static:
    case FormComponentType.MetricBreakdown:
      return

    default:
      if ("field" in component) {
        addSelection(selections, selectionFieldName(component.field))
      }
  }
}

const listItemSelection = (component: {
  readonly field: string
  readonly itemChildren: Record<string, FormComponent>
}) => {
  const nestedSelectionIndent = "                "
  const closingSelectionIndent = "              "
  const selections = new Map<string, string>()
  Object.values(component.itemChildren).forEach((child) => {
    addItemComponentSelection(selections, child)
  })

  return `${component.field} {
${nestedSelectionIndent}${Array.from(selections.values()).join(`\n${nestedSelectionIndent}`)}
${closingSelectionIndent}}`
}

const addComponentSelection = (
  selections: Map<string, string>,
  component: FormComponent,
) => {
  switch (component._tag) {
    case FormComponentType.FieldSet:
      Object.values(component.children).forEach((child) => {
        addComponentSelection(selections, child)
      })
      return

    case FormComponentType.MetricBreakdown:
      if (component.dataSource === "item") {
        addSelection(
          selections,
          component.field,
          metricBreakdownSelection(component.field),
        )
      }
      return

    case FormComponentType.List:
    case FormComponentType.Table:
      addSelection(selections, component.field, listItemSelection(component))
      return

    case FormComponentType.Static:
      return

    default:
      if ("field" in component) {
        addSelection(selections, component.field)
      }
  }
}

const buildDetailSelection = (
  outputFields: readonly string[],
  components: Record<string, FormComponent> | null,
) => {
  const selections = new Map<string, string>()

  for (const field of outputFields) {
    addSelection(selections, field)
  }

  if (components) {
    Object.values(components).forEach((component) => {
      addComponentSelection(selections, component)
    })
  }

  return Array.from(selections.values()).join("\n              ")
}

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
  const { data: availableLists, isLoading: listsLoading } = useQuery({
    queryKey: ["availableLists", session.userId, currentRole],
    queryFn: () => fetchAvailableLists(client),
    staleTime: 60 * 1000,
  })

  // Find the current list from available lists
  const currentList = useMemo(() => {
    if (!availableLists || !listPath) return null
    return availableLists.find((l) => l.path === listPath) ?? null
  }, [availableLists, listPath])

  const {
    data: formMetadata,
    isLoading: formMetadataLoading,
    isFetched: formMetadataFetched,
    error: formMetadataError,
  } = useQuery({
    queryKey: ["listFormMetadata", listPath, session.userId, currentRole],
    queryFn: () => fetchListFormMetadata(client, listPath),
    enabled: !!currentList?.itemQueryName,
    staleTime:
      process.env["NODE_ENV"] === "development" ? 0 : Number.POSITIVE_INFINITY,
    gcTime:
      process.env["NODE_ENV"] === "development" ? 0 : Number.POSITIVE_INFINITY,
  })

  const formComponents = formMetadata?.formDefinition?.components ?? null

  const fieldsSelection = useMemo(() => {
    if (!currentList) return ""

    return buildDetailSelection(
      currentList.outputColumns.map((column) => column.field),
      formComponents,
    )
  }, [currentList, formComponents])
  const metricControlUrlState = useMemo(
    () =>
      collectMetricControlUrlState(
        formComponents,
        new URLSearchParams(controlSearch),
      ),
    [formComponents, controlSearch],
  )
  const metricControlValues = metricControlUrlState.values
  const metricControlValuesKey = JSON.stringify(metricControlValues)
  const hasEmptyItemSelection =
    !!currentList?.itemQueryName &&
    formMetadataFetched &&
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

  // Fetch item details
  const {
    data: itemDetail,
    isLoading: itemLoading,
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

  const isLoading = listsLoading || formMetadataLoading || itemLoading

  return {
    currentList,
    formMetadata,
    itemDetail,
    isLoading,
    error: formMetadataError ?? error,
    refetch,
  }
}
