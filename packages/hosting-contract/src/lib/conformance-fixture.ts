import {
  HOSTED_CAPABILITIES,
  HOSTED_OPERATIONS,
  HOSTING_CONTRACT_FORMAT,
  HOSTING_CONTRACT_FORMAT_VERSION,
  HOSTING_CONTRACT_MAJOR,
  type HostedCapability,
} from "./contract.js"

/**
 * The conformance fixture is the single, typed description of the hosted
 * protocol that the CLI and the private Backend import and check against. It
 * captures what a complete Backend must report and every operation the CLI may
 * issue, so either side can prove -- in a test -- that it implements the same
 * contract.
 */
export interface HostingContractConformanceFixture {
  readonly format: typeof HOSTING_CONTRACT_FORMAT
  readonly version: typeof HOSTING_CONTRACT_FORMAT_VERSION
  readonly major: typeof HOSTING_CONTRACT_MAJOR
  readonly capabilities: ReadonlyArray<HostedCapability>
  readonly operations: ReadonlyArray<{
    readonly id: string
    readonly capability: HostedCapability
    readonly kind: "query" | "mutation"
    readonly graphqlField: string
  }>
}

/**
 * A manifest a conformant Backend reports back to the CLI.
 */
export const CONFORMANCE_MANIFEST = {
  format: HOSTING_CONTRACT_FORMAT,
  version: HOSTING_CONTRACT_FORMAT_VERSION,
  major: HOSTING_CONTRACT_MAJOR,
  capabilities: [...HOSTED_CAPABILITIES],
} as const

export const CONFORMANCE_FIXTURE: HostingContractConformanceFixture = {
  format: HOSTING_CONTRACT_FORMAT,
  version: HOSTING_CONTRACT_FORMAT_VERSION,
  major: HOSTING_CONTRACT_MAJOR,
  capabilities: [...HOSTED_CAPABILITIES],
  operations: Object.values(HOSTED_OPERATIONS).map((operation) => ({
    id: operation.id,
    capability: operation.capability,
    kind: operation.kind,
    graphqlField: operation.graphqlField,
  })),
}
