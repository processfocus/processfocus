# About

Implementation of `AuthorizationService` service from
`@pf/auth-policy` for a locally running Cedar permission check.

# Usage

## Default policies only

```typescript
import {
  LocalCedarAuthorizationLive,
  LocalCedarConfigStatic,
} from "@pf/auth-local-cedar"

const authLayer = Layer.provide(
  LocalCedarAuthorizationLive,
  LocalCedarConfigStatic(),
)
```

## With custom policies (static)

For orgs with custom Cedar policies that don't need hot reload:

```typescript
import {
  LocalCedarAuthorizationLive,
  LocalCedarConfigStatic,
} from "@pf/auth-local-cedar"

const authLayer = Layer.provide(
  LocalCedarAuthorizationLive,
  LocalCedarConfigStatic(["/path/to/custom.cedar"]),
)
```

## With custom policies (hot reload)

For local development with automatic policy reloading on file changes:

```typescript
import {
  LocalCedarAuthorizationLive,
  LocalCedarConfigHotReload,
} from "@pf/auth-local-cedar"

const authLayer = Layer.provide(
  LocalCedarAuthorizationLive,
  LocalCedarConfigHotReload("/path/to/org", ["cedar/custom.cedar"]),
)
```

The hot reload layer:
- Watches all policy files (default from `@pf/auth-policy` + custom) using `fs.watch`
- Automatically reloads on file changes without server restart
- Provides both `LocalCedarConfig` and `PolicyWatcherService`
