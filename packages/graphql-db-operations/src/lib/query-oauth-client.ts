import { Context, type Effect, type Option } from "effect"
import type { SqlError } from "effect/sql/SqlError"

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
export class OAuthClientQueries extends Context.Service<
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
  }
>()("@pf/graphql-db-operations/OAuthClientQueries") {}
