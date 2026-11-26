# @pf/frontend-endpoints

Shared endpoint configuration logic for frontend applications.

Provides functions to determine GraphQL and WebSocket endpoints for both
development and production environments.

The root is browser-safe. Node callers use the explicit
`@pf/frontend-endpoints/port-files` subpath for local filesystem discovery.
AppSync connections and subscription presence belong to `@pf/realtime-client`;
this package does not re-export them.
