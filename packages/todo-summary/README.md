# @pf/todo-summary

Shared service for computing todo summaries from process state.

## Purpose

Extracts summary computation logic that was duplicated between:
- `pullTodo` resolver in `@pf/graphql-api`
- `todo-event` handler in `@pf/job-handler`

## Usage

```typescript
import { TodoSummaryComputation } from "@pf/todo-summary"

const summaryComputation = yield* TodoSummaryComputation
const todosWithSummary = yield* summaryComputation.enrichWithSummaries(todos)
```

## What it does

For each todo, `enrichWithSummaries`:
1. Batch fetches process states from database
2. Batch fetches completed steps per process execution
3. Builds `FlowContext` from completed steps
4. Calls `Form.getSummary()` if the step has a summary function
5. Converts summary record to array format for GraphQL

## Layer Dependencies

`TodoSummaryComputationLive` requires:
- `StepCompletionOperations` (from `@pf/graphql-db-operations`)
- `OrganisationProvider` (from `@pf/process`)
