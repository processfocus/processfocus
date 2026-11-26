# @pf/graphql-schema

The shared GraphQL schema, generated TypeScript types, and API errors.

The schema includes system operations and the replication interface used by
frontend RxDB collections. Organisation-specific operations are generated
separately by
[`@pf/org-to-graphql-schema`](../org-to-graphql-schema/README.md).

[`@pf/graphql-api`](../graphql-api/README.md) combines these into the running API.
