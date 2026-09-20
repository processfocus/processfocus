# generate-rxdb

CLI tool to generate GraphQL schema from RxDB collection Effect Schema definitions.

## About

This utility converts RxDB collections defined as Effect Schemas in `@pf/rxdb-collections` into GraphQL schema files that implement the RxDB replication protocol.

Currently generated:
- `packages/graphql-schema/graphql/rxdb.graphql` - Complete GraphQL schema with types, queries, mutations, and subscriptions

## Usage

```bash
# Generate GraphQL schema from RxDB collections
bun cli/generate-rxdb/src/main.ts

# Then regenerate TypeScript types
npx nx run @pf/graphql-schema:graphql-codegen
```

## Adding New Collections

1. Define your collection schema in `packages/rxdb-collections/src/lib/rxdb-collections.ts`:

```typescript
export const MyNewCollectionSchema = ES.Struct({
  ...RxDbDocumentSchema.fields,
  title: ES.String,
  content: ES.String,
  createdAt: ES.DateTimeUtc,
})
```

2. Add to the `RxDbCollections` export:

```typescript
export const RxDbCollections = {
  DraftProcessExecution: DraftProcessExecutionSchema,
  MyNewCollection: MyNewCollectionSchema,
} as const
```

3. Regenerate the GraphQL schema:

```bash
bun cli/generate-rxdb/src/main.ts
npx nx run @pf/graphql-schema:graphql-codegen
```

## Generated GraphQL

For each collection, the generator creates:
- Main type implementing `RxDbDocument` interface
- `{Collection}PullBulk` type for batch fetching
- Push input types for conflict resolution
- `pull{Collection}` query with checkpoint support
- `push{Collection}` mutation for writes
- `stream{Collection}` subscription for real-time updates

## Type Mappings

| Effect Schema | GraphQL |
|--------------|---------|
| `ES.String` | `String` or `ID` (for `id` fields) |
| `ES.Number` | `Int` or `Float` (heuristic based on field name) |
| `ES.Boolean` | `Boolean` |
| `ES.Unknown` | `JSON` |
| `ES.DateTimeUtc` | `DateTimeISO` |
