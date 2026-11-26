# @processfocus/runtime

Provider-neutral runtime engine and contracts for executing Process Focus
organisations.

It defines queues, job dispatch, runtime artifacts, configuration, document
storage, and notification interfaces. Local and hosted adapters supply platform
startup, storage, and delivery infrastructure.

[`@pf/job-handler`](../job-handler/README.md) provides shared process-job
behavior. Organisation models are authored through
[`processfocus`](../sdk/README.md).

See [configuration authoring](../../docs/cloud-hosting/configuration-authoring.md)
for the contract shared by runtime consumers and deployment preflight.
