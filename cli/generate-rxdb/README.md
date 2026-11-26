# generate-rxdb

Generates the RxDB replication GraphQL schema and collection JSON schemas from
the Effect schemas in `@pf/rxdb-collections`.

When adding or changing a collection, update
[`RxDbCollections`](../../packages/rxdb-collections/src/lib/rxdb-collections.ts),
then run from the workspace root:

```bash
bun scripts/nx-quiet.ts run @pf/graphql-schema:build-rxdb
bun scripts/nx-quiet.ts run @pf/graphql-schema:graphql-codegen
```

Generated files live in `packages/graphql-schema/graphql/rxdb.graphql`,
`packages/rxdb-collections/generated/` and `packages/graphql-schema/src/generated/`.
Change the source schemas rather than editing these outputs.
