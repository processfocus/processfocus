# @pf/org-to-graphql-schema

Generates the organisation-specific GraphQL schema from the authored model,
including form submission types.

[`@pf/graphql-api`](../graphql-api/README.md) combines the result with the
shared [`@pf/graphql-schema`](../graphql-schema/README.md). This lets the API
reflect each organisation's processes without hand-maintained duplicate schemas.
