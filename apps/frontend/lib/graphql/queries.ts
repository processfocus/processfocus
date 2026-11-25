import type { GraphQLClient } from "graphql-request"
import { gql } from "graphql-request"
import { graphql } from "@/lib/generated/gql"

/**
 * Typed query for fetching organization identity.
 */
const orgIdentityQuery = graphql(`
  query OrgIdentity {
    org {
      id
      name
      acronym
      startDayOfWeek
    }
  }
`)

/**
 * Fetch organization identity.
 */
export async function fetchOrgIdentity(client: GraphQLClient) {
  const data = await client.request(orgIdentityQuery)
  return data.org
}

const cedarPoliciesQuery = graphql(`
  query CedarPolicies {
    cedarPolicies {
      policies
      schema
    }
  }
`)

export async function fetchCedarPolicies(client: GraphQLClient) {
  const data = await client.request(cedarPoliciesQuery)
  return data.cedarPolicies
}

// Query for fetching form metadata for a step
// todoId is optional - when provided, state-based defaults are resolved
export const FORM_METADATA_QUERY = gql`
  query FormMetadata($stepPath: String!, $todoId: ID) {
    formMetadata(stepPath: $stepPath, todoId: $todoId) {
      processId
      canSkipScheduleWaits
      stepPath
      processName
      stepName
      processPath
      mutationName
      inputTypeName
      completeMutationName
      requestData
      totalFields
      pluginConfiguration
      defaultValues
    }
  }
`

// Query for fetching lookup suggestions for a searchable select field
export const LOOKUP_SUGGESTIONS_QUERY = gql`
  query LookupSuggestions($stepPath: String!, $field: String!, $filter: String, $limit: Int, $todoId: ID, $listCreate: Boolean) {
    lookupSuggestions(stepPath: $stepPath, field: $field, filter: $filter, limit: $limit, todoId: $todoId, listCreate: $listCreate) {
      value
      label
      searchText
    }
  }
`

export const LOOKUP_SEARCH_QUERY = graphql(`
  query LookupSearch($stepPath: String!, $field: String!, $filter: String, $limit: Int, $todoId: ID, $listCreate: Boolean) {
    lookupSearch(stepPath: $stepPath, field: $field, filter: $filter, limit: $limit, todoId: $todoId, listCreate: $listCreate) {
      items { value label }
      hasMore
    }
  }
`)

export const LOOKUP_SELECTION_QUERY = graphql(`
  query LookupSelection($stepPath: String!, $field: String!, $value: String!, $todoId: ID, $listCreate: Boolean) {
    lookupSelection(stepPath: $stepPath, field: $field, value: $value, todoId: $todoId, listCreate: $listCreate) {
      value
      label
    }
  }
`)

export const CALENDAR_SLOTS_QUERY = gql`
  query CalendarSlots($stepPath: String!, $field: String!, $todoId: ID) {
    calendarSlots(stepPath: $stepPath, field: $field, todoId: $todoId) {
      value
      label
      startsAt
      endsAt
    }
  }
`
