import type { GraphQLClient } from "graphql-request"
import { graphql } from "@/lib/generated/gql"

/**
 * Typed query for fetching paginated users with provider user status.
 */
const allUsersQuery = graphql(`
  query AllUsers($page: Int!, $limit: Int!) {
    allUsers(page: $page, limit: $limit) {
      items {
        id
        provider
        sub
        lastLoggedIn
        isProviderUser
        providerUserName
        providerUserEmail
      }
      totalCount
      page
      limit
      hasNextPage
    }
  }
`)

/**
 * Typed query for fetching paginated OAuth providers.
 */
const allOAuthProvidersQuery = graphql(`
  query AllOAuthProviders($page: Int!, $limit: Int!) {
    allOAuthProviders(page: $page, limit: $limit) {
      items {
        id
        providerName
      }
      totalCount
      page
      limit
      hasNextPage
    }
  }
`)

/**
 * Typed query for fetching paginated invitations with roles and lifecycle.
 */
const allInvitationsQuery = graphql(`
  query AllInvitations(
    $page: Int!
    $limit: Int!
    $status: InvitationLifecycleStatus
  ) {
    allInvitations(page: $page, limit: $limit, status: $status) {
      items {
        id
        email
        status
        roles {
          id
          name
          path
        }
        acceptedAt
        acceptedByProvider
        acceptedBySubject
        acceptedByProviderUserId
        legacyClosedAt
        legacyClosureReason
        registrationLinkStatus
        registrationLinkExpiresAt
        registrationLinkGeneratedAt
        registrationLinkGeneratedBy
        registrationLinkRevealedAt
        registrationLinkRevealedBy
        registrationLinkRevokedAt
        registrationLinkRevokedBy
      }
      totalCount
      page
      limit
      hasNextPage
    }
  }
`)

const invitationDetailQuery = graphql(`
  query InvitationDetail($invitationId: ID!) {
    invitationDetail(invitationId: $invitationId) {
      id
      email
      status
      roles {
        id
        name
        path
      }
      acceptedAt
      acceptedByProvider
      acceptedBySubject
      acceptedByProviderUserId
      legacyClosedAt
      legacyClosureReason
      registrationLinkStatus
      registrationLinkExpiresAt
      registrationLinkGeneratedAt
      registrationLinkGeneratedBy
      registrationLinkRevealedAt
      registrationLinkRevealedBy
      registrationLinkRevokedAt
      registrationLinkRevokedBy
    }
  }
`)

/**
 * Typed query for fetching paginated roles.
 */
const allRolesQuery = graphql(`
  query AllSettingsRoles($page: Int!, $limit: Int!) {
    allRoles(page: $page, limit: $limit) {
      items {
        id
        name
        path
      }
      totalCount
      page
      limit
      hasNextPage
    }
  }
`)

const allInvitationRolesQuery = graphql(`
  query AllInvitationRoles($page: Int!, $limit: Int!) {
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

/**
 * Combined query for fetching all settings data in one request.
 * Fetches users, invitations, roles, and OAuth providers simultaneously.
 */
const allSettingsDataQuery = graphql(`
  query AllSettingsData(
    $usersPage: Int!
    $usersLimit: Int!
    $invitationsPage: Int!
    $invitationsLimit: Int!
    $rolesPage: Int!
    $rolesLimit: Int!
    $providersPage: Int!
    $providersLimit: Int!
  ) {
    allUsers(page: $usersPage, limit: $usersLimit) {
      items {
        id
        provider
        sub
        lastLoggedIn
        isProviderUser
        providerUserName
        providerUserEmail
      }
      totalCount
      page
      limit
      hasNextPage
    }
    allInvitations(
      page: $invitationsPage
      limit: $invitationsLimit
      status: PENDING
    ) {
      items {
        id
        email
        status
        roles {
          id
          name
          path
        }
        acceptedAt
        acceptedByProvider
        acceptedBySubject
        acceptedByProviderUserId
        legacyClosedAt
        legacyClosureReason
        registrationLinkStatus
        registrationLinkExpiresAt
        registrationLinkGeneratedAt
        registrationLinkGeneratedBy
        registrationLinkRevealedAt
        registrationLinkRevealedBy
        registrationLinkRevokedAt
        registrationLinkRevokedBy
      }
      totalCount
      page
      limit
      hasNextPage
    }
    allRoles(page: $rolesPage, limit: $rolesLimit) {
      items {
        id
        name
        path
      }
      totalCount
      page
      limit
      hasNextPage
    }
    allOAuthProviders(page: $providersPage, limit: $providersLimit) {
      items {
        id
        providerName
      }
      totalCount
      page
      limit
      hasNextPage
    }
  }
`)

const createInvitationMutation = graphql(`
  mutation CreateInvitation($email: String!, $roleIds: [ID!]!) {
    createInvitation(input: { email: $email, roleIds: $roleIds }) {
      __typename
      ... on SaveInvitationSuccess {
        invitation {
          id
          email
          status
          roles {
            id
            name
            path
          }
          acceptedAt
          acceptedByProvider
          acceptedBySubject
          acceptedByProviderUserId
          legacyClosedAt
          legacyClosureReason
          registrationLinkStatus
          registrationLinkExpiresAt
          registrationLinkGeneratedAt
          registrationLinkGeneratedBy
          registrationLinkRevealedAt
          registrationLinkRevealedBy
          registrationLinkRevokedAt
          registrationLinkRevokedBy
        }
      }
      ... on SaveInvitationFailure {
        error
      }
    }
  }
`)

const updateInvitationMutation = graphql(`
  mutation UpdateInvitation(
    $invitationId: ID!
    $email: String!
    $roleIds: [ID!]!
  ) {
    updateInvitation(
      invitationId: $invitationId
      input: { email: $email, roleIds: $roleIds }
    ) {
      __typename
      ... on SaveInvitationSuccess {
        invitation {
          id
          email
          status
          roles {
            id
            name
            path
          }
          acceptedAt
          acceptedByProvider
          acceptedBySubject
          acceptedByProviderUserId
          legacyClosedAt
          legacyClosureReason
          registrationLinkStatus
          registrationLinkExpiresAt
          registrationLinkGeneratedAt
          registrationLinkGeneratedBy
          registrationLinkRevealedAt
          registrationLinkRevealedBy
          registrationLinkRevokedAt
          registrationLinkRevokedBy
        }
      }
      ... on SaveInvitationFailure {
        error
      }
    }
  }
`)

const deleteInvitationMutation = graphql(`
  mutation DeleteInvitation($invitationId: ID!) {
    deleteInvitation(invitationId: $invitationId) {
      success
      error
    }
  }
`)

/**
 * Fetch all settings data in a single GraphQL request
 */

const generateRegistrationLinkMutation = graphql(`
  mutation GenerateRegistrationLink($invitationId: ID!) {
    generateRegistrationLink(invitationId: $invitationId) {
      __typename
      ... on RegistrationLinkActionSuccess {
        registrationLinkUrl
        expiresAt
        invitation {
          id
          email
          status
          registrationLinkStatus
          registrationLinkExpiresAt
          registrationLinkGeneratedAt
          registrationLinkGeneratedBy
          registrationLinkRevealedAt
          registrationLinkRevealedBy
          registrationLinkRevokedAt
          registrationLinkRevokedBy
          roles {
            id
            name
            path
          }
        }
      }
      ... on RegistrationLinkActionFailure {
        error
      }
    }
  }
`)

const revealRegistrationLinkMutation = graphql(`
  mutation RevealRegistrationLink($invitationId: ID!) {
    revealRegistrationLink(invitationId: $invitationId) {
      __typename
      ... on RegistrationLinkActionSuccess {
        registrationLinkUrl
        expiresAt
        invitation {
          id
          email
          status
          registrationLinkStatus
          registrationLinkExpiresAt
          registrationLinkGeneratedAt
          registrationLinkGeneratedBy
          registrationLinkRevealedAt
          registrationLinkRevealedBy
          registrationLinkRevokedAt
          registrationLinkRevokedBy
          roles {
            id
            name
            path
          }
        }
      }
      ... on RegistrationLinkActionFailure {
        error
      }
    }
  }
`)

const rotateRegistrationLinkMutation = graphql(`
  mutation RotateRegistrationLink($invitationId: ID!) {
    rotateRegistrationLink(invitationId: $invitationId) {
      __typename
      ... on RegistrationLinkActionSuccess {
        registrationLinkUrl
        expiresAt
        invitation {
          id
          email
          status
          registrationLinkStatus
          registrationLinkExpiresAt
          registrationLinkGeneratedAt
          registrationLinkGeneratedBy
          registrationLinkRevealedAt
          registrationLinkRevealedBy
          registrationLinkRevokedAt
          registrationLinkRevokedBy
          roles {
            id
            name
            path
          }
        }
      }
      ... on RegistrationLinkActionFailure {
        error
      }
    }
  }
`)

const revokeRegistrationLinkMutation = graphql(`
  mutation RevokeRegistrationLink($invitationId: ID!) {
    revokeRegistrationLink(invitationId: $invitationId) {
      __typename
      ... on SaveInvitationSuccess {
        invitation {
          id
          email
          status
          registrationLinkStatus
          registrationLinkExpiresAt
          registrationLinkGeneratedAt
          registrationLinkGeneratedBy
          registrationLinkRevealedAt
          registrationLinkRevealedBy
          registrationLinkRevokedAt
          registrationLinkRevokedBy
          roles {
            id
            name
            path
          }
        }
      }
      ... on SaveInvitationFailure {
        error
      }
    }
  }
`)

export const fetchAllSettingsData = async (
  client: GraphQLClient,
  page: number,
  limit: number,
) => {
  const data = await client.request(allSettingsDataQuery, {
    usersPage: page,
    usersLimit: limit,
    invitationsPage: page,
    invitationsLimit: limit,
    rolesPage: page,
    rolesLimit: limit,
    providersPage: page,
    providersLimit: limit,
  })
  return data
}

/**
 * Fetch paginated users with provider user status
 */
export const fetchAllUsers = async (
  client: GraphQLClient,
  page: number,
  limit: number,
) => {
  const data = await client.request(allUsersQuery, { page, limit })
  return data.allUsers
}

/**
 * Fetch paginated OAuth providers
 */
export const fetchAllOAuthProviders = async (
  client: GraphQLClient,
  page: number,
  limit: number,
) => {
  const data = await client.request(allOAuthProvidersQuery, { page, limit })
  return data.allOAuthProviders
}

/**
 * Fetch paginated invitations with roles and lifecycle status.
 */
export const fetchAllInvitations = async (
  client: GraphQLClient,
  page: number,
  limit: number,
  status: "PENDING" | "ACCEPTED" | "LEGACY_CLOSED" = "PENDING",
) => {
  const data = await client.request(allInvitationsQuery, {
    page,
    limit,
    status,
  })
  return data.allInvitations
}

export const fetchInvitationDetail = async (
  client: GraphQLClient,
  invitationId: string,
) => {
  const data = await client.request(invitationDetailQuery, { invitationId })
  return data.invitationDetail
}

/**
 * Fetch paginated roles
 */
export const fetchAllSettingsRoles = async (
  client: GraphQLClient,
  page: number,
  limit: number,
) => {
  const data = await client.request(allRolesQuery, { page, limit })
  return data.allRoles
}

export const fetchAllInvitationRoles = async (client: GraphQLClient) => {
  // The invitation form renders all roles as checkboxes until the picker
  // supports search or pagination.
  const limit = 500
  const data = await client.request(allInvitationRolesQuery, {
    page: 1,
    limit,
  })

  if (data.allRoles.totalCount > data.allRoles.items.length) {
    throw new Error(
      "This organisation has too many roles to load in the invitation form. Please contact support.",
    )
  }

  return data.allRoles.items
}

export const createInvitation = async (
  client: GraphQLClient,
  email: string,
  roleIds: string[],
) => {
  const data = await client.request(createInvitationMutation, {
    email,
    roleIds,
  })

  return data.createInvitation
}

export const updateInvitation = async (
  client: GraphQLClient,
  invitationId: string,
  email: string,
  roleIds: string[],
) => {
  const data = await client.request(updateInvitationMutation, {
    invitationId,
    email,
    roleIds,
  })

  return data.updateInvitation
}

export const deleteInvitation = async (
  client: GraphQLClient,
  invitationId: string,
) => {
  const data = await client.request(deleteInvitationMutation, {
    invitationId,
  })

  return data.deleteInvitation
}

export async function generateRegistrationLink(
  client: GraphQLClient,
  invitationId: string,
) {
  const data = await client.request(generateRegistrationLinkMutation, {
    invitationId,
  })
  return data.generateRegistrationLink
}

export async function revealRegistrationLink(
  client: GraphQLClient,
  invitationId: string,
) {
  const data = await client.request(revealRegistrationLinkMutation, {
    invitationId,
  })
  return data.revealRegistrationLink
}

export async function rotateRegistrationLink(
  client: GraphQLClient,
  invitationId: string,
) {
  const data = await client.request(rotateRegistrationLinkMutation, {
    invitationId,
  })
  return data.rotateRegistrationLink
}

export async function revokeRegistrationLink(
  client: GraphQLClient,
  invitationId: string,
) {
  const data = await client.request(revokeRegistrationLinkMutation, {
    invitationId,
  })
  return data.revokeRegistrationLink
}
