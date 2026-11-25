import { graphql } from "@/lib/generated/gql"

export const anonymousPageQuery = graphql(`
  query AnonymousPage($address: String!) {
    anonymousPage(address: $address) {
      name
      stepPath
      afterSubmit
      formPath
      requestData
      pluginConfiguration
      defaultValues
    }
  }
`)

export const anonymousPageLookupQuery = graphql(`
  query AnonymousPageLookup($address: String!, $field: String!, $filter: String, $limit: Int, $selectedValue: String) {
    anonymousPageLookup(address: $address, field: $field, filter: $filter, limit: $limit, selectedValue: $selectedValue) { value label searchText }
  }
`)

export const submitAnonymousPageMutation = graphql(`
  mutation SubmitAnonymousPage($address: String!, $input: JSON!) {
    submitAnonymousPage(address: $address, input: $input)
  }
`)
