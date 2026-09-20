import type { SqlError } from "@effect/sql/SqlError"
import { Context, type Effect, type Option } from "effect"

/**
 * Database row type for OAuth client (simplified for queries)
 */
export interface OAuthClientRow {
  readonly id: string
  readonly clientId: string
}

/**
 * Service providing OAuth client query operations for GraphQL resolvers
 */
export class OAuthClientQueries extends Context.Tag(
  "@pf/graphql-db-operations/OAuthClientQueries",
)<
  OAuthClientQueries,
  {
    /**
     * Find OAuth client by client ID (the external identifier, not the database ID)
     */
    readonly queryOAuthClientByClientId: (
      clientId: string,
    ) => Effect.Effect<Option.Option<OAuthClientRow>, SqlError>

    /**
     * Set a permitted role for an OAuth client (for role switching)
     * Upserts to the permitted_client_role table
     */
    readonly addPermittedClientRole: (
      oauthClientId: string,
      roleId: string,
    ) => Effect.Effect<void, SqlError>

    /**
     * Set a permitted provider user email for an OAuth client (for impersonation)
     * Upserts to the permitted_client_email table
     */
    readonly addPermittedClientEmail: (
      oauthClientId: string,
      email: string,
    ) => Effect.Effect<void, SqlError>
  }
>() {}
