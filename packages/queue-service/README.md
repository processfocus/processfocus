# Queue Service

Schedule jobs to be picked up by workers. Interface for background job queuing based on AWS SQS semantics.

## Overview

This package provides a queue service interface that works consistently across multiple backends:
- SQLite (via `@pf/sqlite-queue-service`)
- Postgres (via `@pf/postgres-queue-service`)
- AWS SQS (via runtime implementation)

## Architecture

The queue service follows SQS semantics:

- **Visibility timeout**: When a job is claimed, it becomes invisible to other workers for a configurable duration. If the worker crashes or fails to acknowledge, the job automatically becomes visible again after the timeout expires.
- **Atomic claim operation**: The claim operation atomically increments attempts and sets the lock, preventing double-claiming.
- **Claim receipts**: Every claim returns a unique opaque receipt. Acknowledge, fail, and visibility operations require that receipt so an expired worker cannot mutate a newer claim.
- **Explicit acknowledgment**: Jobs remain in the queue until explicitly marked complete or failed. No implicit deletion.
- **At-least-once delivery**: Failed jobs (explicit or timeout) are automatically retried up to the configured retry limit.

Note: This does NOT guarantee exactly-once delivery. Consumers must be idempotent or handle duplicates.

## Core Operations

- `enqueue` - Add job for immediate processing
- `enqueueWithDelay` - Schedule job for future processing
- `claim` - Claim next available job (becomes invisible to other workers)
- `acknowledge` - Mark job as successfully completed (deletes from queue)
- `fail` - Mark job as failed (will be retried unless max retries reached)
- `extendVisibility` - Extend visibility timeout for jobs needing more processing time
- `getStats` - Get queue statistics (pending, processing, dead letter counts)

## Job Lifecycle

1. Job is enqueued with optional delay
2. When `available_at` time is reached, job becomes claimable
3. Worker claims job, which sets `locked_until` (visibility timeout)
4. Worker processes job and either:
   - Calls `acknowledge` (success) - job is deleted
   - Calls `fail` (failure) - job is retried if attempts < maxRetries
   - Crashes/times out - job becomes visible again after `locked_until`

## Defaults

- Visibility timeout: 30 seconds
- Max retries: 5 attempts

## Implementation Notes

**SQLite**: Uses `BEGIN IMMEDIATE` transaction mode for atomic claims. Single writer pattern means claims are serialized. Suitable for low-medium throughput.

**Postgres**: Uses `FOR UPDATE SKIP LOCKED` for efficient concurrent claiming. Suitable for higher throughput scenarios.

**AWS SQS**: Maps directly to SQS operations (`SendMessage`, `ReceiveMessage`, `DeleteMessage`, `ChangeMessageVisibility`).
