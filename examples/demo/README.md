# Reference organisation

This organisation supplies executable workflow and integration fixtures,
including purchase requests and shared forms.

`src/org.ts` composes processes, roles and authentication.
`src/index.ts` is the build entry point, including bundled database-import logic.

From the repository root:

```bash
bun scripts/nx-quiet.ts run @pf/demo:build
```

The build produces the organisation bundle, GraphQL schema and Cedar policies.
Import uses that bundle and requires configuration for the selected runtime.
