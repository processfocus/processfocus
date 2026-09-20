import type { GraphQLClient } from "graphql-request"
import { graphql } from "@/lib/generated/gql"

/**
 * Typed query for fetching current provider user data.
 */
const currentProviderUserQuery = graphql(`
  query CurrentProviderUser {
    currentProviderUser {
      id
      email
      name
      firstName
      lastName
      picture
      locale
      permittedRoles {
        id
        name
        path
      }
    }
  }
`)

/**
 * Mutation for requesting a specific role.
 */
const requestRoleMutation = graphql(`
  mutation RequestRole($rolePath: String!) {
    requestRole(rolePath: $rolePath) {
      success
      rolePath
      error
    }
  }
`)

/**
 * Fetch current provider user data
 * @param client - Optional GraphQL client to use. If not provided, uses the default server-side client
 * @throws {Error} When GraphQL request fails or user is not authenticated
 */
export const fetchCurrentProviderUser = async (client: GraphQLClient) => {
  try {
    const data = await client.request(currentProviderUserQuery)
    return data.currentProviderUser
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to fetch current provider user: ${error.message}`)
    }
    throw new Error("Failed to fetch current provider user: Unknown error")
  }
}

/**
 * Request a specific role
 * @param client - GraphQL client to use
 * @param rolePath - The path of the role to request (e.g., "Manager")
 * @returns The result of the request operation
 */
export const requestRole = async (client: GraphQLClient, rolePath: string) => {
  const data = await client.request(requestRoleMutation, { rolePath })
  return data.requestRole
}
