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
      stepPath
      processName
      stepName
      processPath
      mutationName
      inputTypeName
      completeMutationName
      totalFields
      formDefinition
      defaultValues
      jsonSchema
    }
  }
`

// Query for fetching lookup suggestions for a searchable select field
export const LOOKUP_SUGGESTIONS_QUERY = gql`
  query LookupSuggestions($stepPath: String!, $field: String!, $filter: String, $limit: Int, $todoId: ID) {
    lookupSuggestions(stepPath: $stepPath, field: $field, filter: $filter, limit: $limit, todoId: $todoId) {
      value
      label
    }
  }
`

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
