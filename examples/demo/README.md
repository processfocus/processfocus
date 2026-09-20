# About

Demo organisation with various processes to test and demonstrate
Process Focus capabilities.

# Entry Points

- `src/org.ts` - Org definition with processes, roles, auth config, and invitations.
- `src/index.ts` - Re-exports from `src/org.ts` as the build entrypoint.

`pfcli build` bundles `src/index.ts`, so the built artifact contains the full org
and bundled `dbImport` logic used by `pfcli import` and deploy-time import.

# Build

Build the org bundle and generate artifacts:

```sh
npx nx run @pf/demo:build
```

This generates:
- `dist/org.js` - Bundled organisation (from `src/index.ts`)
- `dist/graphql/org.graphql` - GraphQL schema
- `dist/cedar/` - Cedar policy files

# Import

Import the organisation to the database:

```sh
npx nx run @pf/demo:import
```

Note: Import requires auth environment variables since the full org
entrypoint includes AuthenticationConfig, and `pfcli import` executes the
built `dist/org.js` bundle rather than loading source directly.
