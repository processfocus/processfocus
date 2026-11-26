import type { GraphQLClient } from "graphql-request"
import { graphql } from "@/lib/generated/gql"

const userDetailQuery = graphql(`
  query UserDetail($userId: ID!) {
    userDetail(userId: $userId) {
      id
      provider
      sub
      lastLoggedIn
      taskAssignmentEmailAvailable
      providerUser {
        id
        email
        name
        firstName
        lastName
        roleIds
        notificationPreferences {
          notifications {
            todoAssignment {
              email
            }
            executionFailure {
              email
            }
          }
        }
      }
    }
  }
`)

const allRolesQuery = graphql(`
  query AllRoles($page: Int!, $limit: Int!) {
    allRoles(page: $page, limit: $limit) {
      items {
        id
        name
        path
      }
      totalCount
    }
  }
`)

const saveProviderUserMutation = graphql(`
  mutation SaveProviderUser(
    $providerUserId: ID!
    $userId: ID!
    $roleIds: [ID!]!
    $firstName: String
    $lastName: String
    $preferences: NotificationPreferencesInput!
  ) {
    updateProviderUser(
      providerUserId: $providerUserId
      input: {
        roleIds: $roleIds
        firstName: $firstName
        lastName: $lastName
      }
    ) {
      __typename
      ... on UpdateProviderUserSuccess {
        providerUser {
          id
          email
          name
          firstName
          lastName
          roleIds
        }
      }
      ... on UpdateProviderUserFailure {
        error
      }
    }
    updateNotificationPreferences(userId: $userId, preferences: $preferences) {
      __typename
      ... on UpdateNotificationPreferencesSuccess {
        preferences {
          notifications {
            todoAssignment {
              email
            }
            executionFailure {
              email
            }
          }
        }
      }
      ... on UpdateNotificationPreferencesFailure {
        error
      }
    }
  }
`)

export const fetchUserDetail = async (
  client: GraphQLClient,
  userId: string,
) => {
  const data = await client.request(userDetailQuery, { userId })
  return data.userDetail
}

export const fetchAllRoles = async (client: GraphQLClient) => {
  const data = await client.request(allRolesQuery, {
    page: 1,
    limit: 1000,
  })
  return data.allRoles.items
}

export const saveProviderUser = async (
  client: GraphQLClient,
  providerUserId: string,
  userId: string,
  roleIds: string[],
  taskAssignmentEmailEnabled: boolean | undefined,
  executionFailureEmailEnabled: boolean,
  names?: { firstName: string; lastName: string },
) => {
  const data = await client.request(saveProviderUserMutation, {
    providerUserId,
    userId,
    roleIds,
    ...names,
    preferences: {
      notifications: {
        ...(taskAssignmentEmailEnabled !== undefined && {
          todoAssignment: { email: taskAssignmentEmailEnabled },
        }),
        executionFailure: {
          email: executionFailureEmailEnabled,
        },
      },
    },
  })
  return {
    providerUser: data.updateProviderUser,
    notificationPreferences: data.updateNotificationPreferences,
  }
}
