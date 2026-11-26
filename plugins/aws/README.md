# @processfocus/plugin-aws-lambda

Invoke AWS Lambda functions from a Process Focus system step using
`AwsFunctionStep`:

```ts
import { AwsFunctionStep } from "@processfocus/plugin-aws-lambda"
```

The organisation defines the function invocation and its input. The runtime host
supplies AWS credentials, region and invocation routing.

See [plugin configuration](../CONFIGURATION.md) for how plugins fit into an
organisation.
