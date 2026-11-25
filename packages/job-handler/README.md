# @pf/job-handler

Shared background-job handling for local and hosted Process Focus runtimes.

Handlers advance process flows, run automated steps, deliver notifications, and
publish changes to connected clients. Runtime adapters supply the queue,
database, email sender, and realtime transport.

This separation keeps process behavior consistent across deployments while
allowing each runtime to use its own infrastructure.

Expected system-step failures can retry or follow authored error flows.
Non-retryable failures and programming defects stop retries; see
[the handler](./src/handlers/system-step-execution.ts) for failure handling.

Queue and delivery contracts live in
[`@processfocus/runtime`](../runtime/README.md).
