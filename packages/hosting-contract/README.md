# @processfocus/hosting-contract

The stable, versioned protocol between the Process Focus CLI
(`@processfocus/cli`) and the hosted Backend.

The package owns the contract format and major, the hosted capability and
operation inventory, typed operation documents, capability negotiation, stable
errors, and conformance fixtures. It contains no Backend implementation, cloud
topology, credentials, or private process policy.

## Contents

- `HOSTING_CONTRACT_FORMAT`, `HOSTING_CONTRACT_FORMAT_VERSION`, and
  `HOSTING_CONTRACT_MAJOR` pin the protocol identity.
- `HOSTED_CAPABILITIES` and `HOSTED_OPERATIONS` enumerate every hosted CLI area
  and its operations.
- `parseHostingContractManifest` and `negotiateHostingContract` validate a
  Backend-reported manifest and fail with actionable upgrade guidance before any
  mutation can run.
- `src/lib/schema.ts` provides typed `effect/Schema` operation documents and
  response schemas for auth, projects, deploy, logs, database operations,
  domains, config, stages, environments, and role grants.
- `src/lib/conformance-fixture.ts` ships the conformance fixture both the CLI
  and the Backend use to prove they implement the same contract.

## Build

Run `bun scripts/nx-quiet.ts run @processfocus/hosting-contract:build` from the
workspace root.

## Test

Run `bun scripts/nx-quiet.ts run @processfocus/hosting-contract:test` from the
workspace root.
