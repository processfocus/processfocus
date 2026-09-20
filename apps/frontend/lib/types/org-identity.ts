import type { OrgIdentityQuery } from "@/lib/generated/gql/graphql"

/**
 * Organization identity type derived from GraphQL OrgIdentityQuery.
 * Used throughout the app for displaying org info in sidebar, etc.
 */
export type OrgIdentity = NonNullable<OrgIdentityQuery["org"]>
