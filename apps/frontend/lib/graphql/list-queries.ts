import type { GraphQLClient } from "graphql-request"
import {
  type ClientFormDefinition,
  parseNullableClientFormDefinition,
} from "@pf/form-client-representation/client-form-definition"
import { graphql } from "@/lib/generated/gql"
import type { ListFormMetadataQuery } from "@/lib/generated/gql/graphql"

export type ListSortInput = {
  readonly field: string
  readonly direction: "ASC" | "DESC"
}

export type ListQueryVariables = {
  readonly page: number
  readonly limit: number
  readonly filter: string | null
  readonly sort?: ListSortInput
}

const LIST_PAGE_SIZE_LIMIT = 100

// Validates GraphQL field names read from URL parameters.
const graphqlNamePattern = /^[_A-Za-z][_0-9A-Za-z]*$/

function isGraphqlName(name: string): boolean {
  return graphqlNamePattern.test(name)
}

export function assertGraphqlName(name: string, label: string): void {
  if (!isGraphqlName(name)) {
    throw new Error(`Invalid GraphQL ${label}: ${name}`)
  }
}

/**
 * Typed query for fetching available lists.
 */
export const availableListsQuery = graphql(`
  query AvailableLists {
    availableLists {
      id
      path
      name
      detailName
      canCreate
      purpose
      queryName
      outputColumns {
        field
        label
        description
        visibleInList
        sortable
      }
      itemQueryName
      updateMutationName
      updateInputTypeName
      deleteMutationName
      editableColumns {
        field
        label
        description
      }
    }
  }
`)

/**
 * Typed query for fetching list form metadata for editing.
 */
const listFormMetadataQuery = graphql(`
  query ListFormMetadata($listPath: String!) {
    listFormMetadata(listPath: $listPath) {
      listPath
      listName
      updateMutationName
      updateInputTypeName
      deleteMutationName
      formDefinition
      defaultValues
      jsonSchema
    }
  }
`)

/**
 * Fetch lists available to the current user.
 */
export async function fetchAvailableLists(client: GraphQLClient) {
  const data = await client.request(availableListsQuery)
  return data.availableLists
}

export type AvailableList = Awaited<
  ReturnType<typeof fetchAvailableLists>
>[number]

export type ParsedListFormMetadata = Omit<
  NonNullable<ListFormMetadataQuery["listFormMetadata"]>,
  "formDefinition"
> & {
  readonly formDefinition: ClientFormDefinition | null
}

export type ListDataResult = {
  readonly items: readonly unknown[]
  readonly totalCount: number
  readonly page: number
  readonly limit: number
  readonly hasNextPage: boolean
}

function buildListDataQuery(list: AvailableList): string {
  const queryName = list.queryName
  assertGraphqlName(queryName, "query name")
  for (const column of list.outputColumns) {
    assertGraphqlName(column.field, "field name")
  }
  const itemsSelection = list.outputColumns
    .map((c) => c.field)
    .join("\n              ")

  return `
    query ListData($page: Int!, $limit: Int!, $filter: String, $sort: ListSortInput) {
      ${queryName}(page: $page, limit: $limit, filter: $filter, sort: $sort) {
        items {
          ${itemsSelection}
        }
        totalCount
        page
        limit
        hasNextPage
      }
    }
  `
}

export async function fetchListData(
  client: GraphQLClient,
  list: AvailableList,
  variables: ListQueryVariables,
): Promise<ListDataResult> {
  const result = await client.request<Record<string, ListDataResult>>(
    buildListDataQuery(list),
    variables,
  )

  return result[list.queryName] as ListDataResult
}

/**
 * Parse sort state from frontend URL parameter values.
 */
export function parseListSort(
  field: string | null,
  direction: string | null,
): ListSortInput | null {
  if (!field || !direction || !isGraphqlName(field)) {
    return null
  }

  if (direction === "asc") {
    return { field, direction: "ASC" }
  }

  if (direction === "desc") {
    return { field, direction: "DESC" }
  }

  return null
}

export function buildListQueryVariables({
  page,
  limit,
  filter,
  sort,
}: {
  readonly page: number
  readonly limit: number
  readonly filter: string | null
  readonly sort: ListSortInput | null
}): ListQueryVariables {
  return {
    page,
    limit,
    filter: filter || null,
    ...(sort ? { sort } : {}),
  }
}

export function parseListPageNumber(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number.parseInt(value ?? "", 10)

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function parseListPageSize(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number.parseInt(value ?? "", 10)

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }

  return Math.min(parsed, LIST_PAGE_SIZE_LIMIT)
}

export function applyListFilterToSearchParams(
  searchParams: URLSearchParams,
  filter: string,
): string {
  const newParams = new URLSearchParams(searchParams.toString())
  if (filter) {
    newParams.set("filter", filter)
  } else {
    newParams.delete("filter")
  }
  newParams.set("page", "1")
  return newParams.toString()
}

export function applyListPageToSearchParams(
  searchParams: URLSearchParams,
  page: number,
): string {
  const newParams = new URLSearchParams(searchParams.toString())
  newParams.set("page", String(parseListPageNumber(String(page), 1)))
  return newParams.toString()
}

export function applyListSortToSearchParams(
  searchParams: URLSearchParams,
  field: string,
): string {
  const newParams = new URLSearchParams(searchParams.toString())

  if (!isGraphqlName(field)) {
    return newParams.toString()
  }

  const currentSort = newParams.get("sort")
  const currentDirection = newParams.get("dir")

  if (currentSort === field && currentDirection === "asc") {
    newParams.set("dir", "desc")
  } else if (currentSort === field && currentDirection === "desc") {
    newParams.delete("sort")
    newParams.delete("dir")
  } else {
    newParams.set("sort", field)
    newParams.set("dir", "asc")
  }

  newParams.set("page", "1")
  return newParams.toString()
}

/**
 * Fetch form metadata for editing a list item.
 */
export async function fetchListFormMetadata(
  client: GraphQLClient,
  listPath: string,
): Promise<ParsedListFormMetadata | null> {
  const data = await client.request(listFormMetadataQuery, { listPath })
  const metadata = data.listFormMetadata
  if (!metadata) return null

  return {
    ...metadata,
    formDefinition: parseNullableClientFormDefinition(
      metadata.formDefinition,
      "listFormMetadata.formDefinition",
    ),
  }
}

/**
 * Export a list as CSV. Returns a signed download URL.
 */
export async function exportListCsv(
  client: GraphQLClient,
  listPath: string,
  options?: {
    readonly filter?: string | null
    readonly sort?: ListSortInput | null
  },
): Promise<{ downloadUrl: string }> {
  const data = await client.request(
    graphql(`
      mutation ExportListCsv(
        $listPath: String!
        $filter: String
        $sort: ListSortInput
      ) {
        exportListCsv(listPath: $listPath, filter: $filter, sort: $sort) {
          downloadUrl
        }
      }
    `),
    {
      listPath,
      filter: options?.filter ?? null,
      sort: options?.sort ?? null,
    },
  )
  return data.exportListCsv
}

export const listCreateFormMetadataQuery = graphql(`
  query ListCreateFormMetadata($listPath: String!) {
    listCreateFormMetadata(listPath: $listPath) {
      createMutationName
      createInputTypeName
      formDefinition
      defaultValues
      jsonSchema
    }
  }
`)
