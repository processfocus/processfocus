# @pf/job-handler

Shared job handler infrastructure for Process Focus runtimes. Provides the core job processing logic and abstractions that are used by both AWS Lambda and local runtime environments.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        @pf/job-handler                          │
│  ┌─────────────────────┐    ┌─────────────────────────────────┐ │
│  │ TodoFromJobPublisher│    │       todoEventHandler          │ │
│  │   (Service Tag)     │◄───│ (uses TodoFromJobPublisher)     │ │
│  └─────────────────────┘    └─────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                │                              │
                │ implemented by               │ used by
                ▼                              ▼
┌───────────────────────────┐    ┌───────────────────────────────┐
│      @runtime/aws         │    │       @runtime/local          │
│  ┌─────────────────────┐  │    │  ┌─────────────────────────┐  │
│  │  AppSync publisher  │  │    │  │     HTTP publisher      │  │
│  │ (blocking + retry)  │  │    │  │  (fire-and-forget)      │  │
│  └─────────────────────┘  │    │  └─────────────────────────┘  │
│           │               │    │             │                 │
│           ▼               │    │             ▼                 │
│    AppSync Events API     │    │    GraphQL Server             │
│    (WebSocket push)       │    │    /internal/todo-event       │
└───────────────────────────┘    └───────────────────────────────┘
```

## Services

### TodoFromJobPublisher

An Effect service abstraction for publishing todo creation events to the frontend. Different runtimes provide different implementations:

- **AWS**: `AppSyncTodoFromJobPublisherLive` - Publishes directly to AppSync Events via IAM-signed HTTP. Uses blocking calls with exponential retry since Lambda may terminate after returning.
- **Local**: `HttpTodoFromJobPublisherLive` - Posts to the GraphQL server's internal endpoint. Uses fire-and-forget pattern since the local runtime keeps running.

```typescript
import {
  TodoFromJobPublisher,
  TodoFromJobPublishError,
} from "@pf/job-handler"

// The service interface
class TodoFromJobPublisher extends Context.Tag(
  "@pf/job-handler/TodoFromJobPublisher",
)<
  TodoFromJobPublisher,
  {
    readonly publishTodosCreated: (
      todos: readonly TodoRow[],
    ) => Effect.Effect<void, TodoFromJobPublishError, never>
  }
>() {}
```

## Handlers

### notificationDeliveryHandler

Processes `notification-delivery` queue jobs for channels such as email.

- Requires a `NotificationDeliveryConfig` implementation that provides `getFrontendBaseUrl()`.
- Email delivery also requires `getSenderIdentity()` to return a sender email.
- If no sender identity is configured, the handler logs a warning and skips delivery.

Configure sender identity in the runtime layer that provides `NotificationDeliveryConfig` to the job worker.

- `getSenderIdentity()` should return the sender email used for notification emails
- It may also return an optional display name

The exact configuration source is org-specific. For example, the school org reads these values from environment variables in `examples/school/src/org.ts`.

### flowExecutionHandler

Processes flow-execution queue jobs. When a process starts or a step completes, this handler:

1. Queries the flow from the database
2. Evaluates any condition against process state
3. Creates a ToDo if the condition passes (or no condition exists)
4. Enqueues a `todo-event` job for publication by `TodoFromJobPublisher`

```typescript
import { flowExecutionHandler, FlowExecutionPayloadSchema } from "@pf/job-handler"

// Register with queue infrastructure
const queueHandlers = {
  "flow-execution": flowExecutionHandler,
}
```

### systemStepExecutionHandler

Processes `system-step-execution` queue jobs for automated system steps.

Failure classification follows Effect channels:

- `Effect.fail(...)` and tagged expected errors are retryable while retries remain, unless the error sets `retryable: false`. On the final attempt, the handler records the todo failure and evaluates matching `onError` flows.
- Tagged failures with `retryable: false` (deterministic validation or unsupported-operation refusals) fail the todo immediately without delayed retries.
- `Effect.die(...)`, `Effect.orDie`, and other defects are fatal/non-retryable. The handler records the todo failure and marks the job completed immediately.
- Use the failure channel for transient API errors or business-domain failures that may recover or route through normal `onError` handling. Use the defect channel for deployment/configuration/programming faults such as missing required environment variables.

## Errors

```typescript
import {
  FlowNotFoundError,
  InvalidProcessStateError,
  ProcessStateNotFoundError,
  TodoFromJobPublishError,
} from "@pf/job-handler"
```

## Usage

### AWS Runtime

```typescript
import { todoEventHandler } from "@pf/job-handler"
import { AppSyncTodoFromJobPublisherLive } from "../services/todo-from-job-publisher"

const AppLayer = Layer.mergeAll(
  // ... other layers
  AppSyncTodoFromJobPublisherLive,
)

// Use todoEventHandler in your job worker
```

### Local Runtime

```typescript
import { todoEventHandler } from "@pf/job-handler"
import { HttpTodoFromJobPublisherLive } from "../services/http-todo-from-job-publisher"

const AppLayer = Layer.mergeAll(
  // ... other layers  
  HttpTodoFromJobPublisherLive,
)

// Use todoEventHandler in your queue poller
```

## Dependencies

- `@pf/graphql-db-operations` - Database operations and TodoRow type
- `@pf/process` - ConditionEvaluator for flow conditions
- `@pf/queue-service` - Job type definition
- `effect` - Effect TS runtime
