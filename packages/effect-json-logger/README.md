# @pf/effect-json-logger

Effect logger that writes JSON directly to stdout for AWS Lambda environments.

## Why this package exists

Effect's built-in `Logger.json` uses `console.log` internally, which AWS Lambda wraps with its own formatting. This results in nested/malformed JSON in CloudWatch logs:

```
2024-01-15T10:30:00.000Z	abc123	INFO	{"message":"hello","level":"INFO",...}
```

This package bypasses `console.log` by writing directly to `process.stdout`, producing clean JSON that CloudWatch and log aggregation tools can parse correctly:

```json
{"message":"hello","logLevel":"INFO","timestamp":"2024-01-15T10:30:00.000Z","fiberId":"#0","annotations":{},"spans":{}}
```

## Usage

```typescript
import { Effect } from "effect"
import { StdoutJsonLoggerLive } from "@pf/effect-json-logger"

const program = Effect.gen(function* () {
  yield* Effect.log("Processing started")
  yield* Effect.logInfo("User logged in").pipe(
    Effect.annotateLogs({ userId: "123" })
  )
})

// Provide the logger layer
const runnable = program.pipe(Effect.provide(StdoutJsonLoggerLive))

Effect.runPromise(runnable)
```

## Exports

- `stdoutJsonLogger` - The raw `Logger.Logger<unknown, void>` instance
- `StdoutJsonLoggerLive` - A `Layer` that replaces the default logger
