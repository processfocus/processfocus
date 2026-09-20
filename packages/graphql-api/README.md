# @pf/graphql-api

A reusable Effect-based GraphQL server package for the Process Focus business process system. This package provides pre-configured GraphQL server components using GraphQL Yoga and Effect, combining static schema definitions with dynamically generated schemas from organization structures.

## Features

- **Effect-based architecture**: Built on Effect for composable, type-safe server logic
- **Hybrid schema approach**: Combines static GraphQL schemas with dynamically generated schemas from organization definitions
- **GraphQL Yoga integration**: Uses GraphQL Yoga for a modern, standards-compliant GraphQL server
- **Layer-based composition**: Provides reusable Effect layers for schema building and server setup
- **Type-safe operations**: Integrates with typed database operations for organizations and processes

## Exports

### Services

- `AppSchemaBuilder` - Service for building the complete GraphQL schema
- `Yoga` - GraphQL Yoga server instance service
- `EffectRuntime` - Managed runtime for executing Effects within GraphQL resolvers

### Layers

- `AppSchemaBuilderLive` - Layer providing the schema builder implementation
- `YogaLive` - Layer providing the configured GraphQL Yoga server

### Custom Schema Integration

The package automatically integrates:

1. **Static schema**: Loaded from `@pf/graphql-schema/schema`
2. **Dynamic schema**: Generated from your organization structure via `@pf/org-to-graphql-schema`
3. **Scalar types**: Includes DateTime scalar support via `graphql-scalars`

### Required Dependencies

To use this package, you need to provide layers for:

- `OrgQueries` - Organization query operations
- `ProcessQueries` - Process query operations
- `ProcessExecutionOperations` - Process execution operations
- `OrganisationProvider` - from `@pf/process`
- A database layer (e.g., `TypedSqliteDrizzleLayer`)

## Authentication

All requests need to be authenticated. The server supports two modes of authorisation:

1. Access token in Authorization header: `Authorization: Bearer ACCESSTOKEN`.
2. Access token in HTTP only cookies. This should be used by browsers,
   so the access token given by the authorisation server is not
   readable by any javascript.
