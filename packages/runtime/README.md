# @processfocus/runtime

Provider-neutral Process Focus runtime engine and contracts.

The package owns the queue contract, shared job dispatch and classification,
runtime artifact envelope parsing, and the composition operations used by local
and hosted adapters. Platform startup, storage mechanics, queue transports, and
deployment policy stay in their adapters.

## Build

Run `bun scripts/nx-quiet.ts run @processfocus/runtime:build` from the workspace
root.

## Test

Run `bun scripts/nx-quiet.ts run @processfocus/runtime:test` from the workspace
root.
