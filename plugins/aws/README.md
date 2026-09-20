# @processfocus/plugin-aws-lambda

Official Process Focus plugin for invoking AWS Lambda functions from a
`SystemStep`.

```ts
import { AwsFunctionStep } from "@processfocus/plugin-aws-lambda"
```

The package root is authoring-safe. It contains no private AWS runtime stacks,
account configuration, or operator tooling.

## Build

Run `bun scripts/nx-quiet.ts run @processfocus/plugin-aws-lambda:build` from the
workspace root.

## Test

Run `bun scripts/nx-quiet.ts run @processfocus/plugin-aws-lambda:test` from the
workspace root.
