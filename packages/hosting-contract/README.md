# @processfocus/hosting-contract

The versioned protocol between the Process Focus CLI and the hosted Backend.

It defines operations, capabilities, request/response schemas, and stable
errors. Capability negotiation lets the CLI detect incompatible Backend
versions and give upgrade guidance before attempting a mutation.

The CLI and Backend share this contract; hosting implementation and deployment
policy belong to the Backend.

See the [exports](./src/index.ts) for protocol definitions and negotiation.
