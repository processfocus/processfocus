# @pf/graphql-api

The shared Process Focus GraphQL server, composed with GraphQL Yoga and Effect.
Local and hosted runtimes provide its database, identity, authorization, and
delivery services.

The API combines the shared system schema with operations generated from the
organisation model. It exposes process work and organisation data, and supports
frontend replication and realtime updates.

Authentication identifies the caller; Cedar checks control access to protected
operations and resources.

## Related packages

- [`@pf/graphql-schema`](../graphql-schema/README.md): shared schema and types.
- [`@pf/org-to-graphql-schema`](../org-to-graphql-schema/README.md):
  organisation-specific schema generation.
- [`@pf/graphql-db-operations`](../graphql-db-operations/README.md):
  database service contracts.
