import { Data } from "effect"
import type { HostedCapability } from "./contract.js"

/**
 * Raised when a Backend-reported manifest is not structurally a hosting
 * contract document at all.
 */
export class HostingContractParseError extends Data.TaggedError(
  "HostingContractParseError",
)<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Raised when a Backend returns a manifest whose protocol major this client
 * does not implement. The client must treat this as terminal and refuse to
 * issue any hosted mutation.
 */
export class UnsupportedHostingContractError extends Data.TaggedError(
  "UnsupportedHostingContractError",
)<{
  readonly detectedMajor: number
  readonly supportedMajor: number
  readonly message: string
  readonly upgradeHint: string
}> {}

/**
 * Raised when the negotiated contract does not advertise a required capability
 * (for example, `deploy` when the Backend is too old for progress streams).
 */
export class UnsupportedHostingCapabilityError extends Data.TaggedError(
  "UnsupportedHostingCapabilityError",
)<{
  readonly capability: HostedCapability
  readonly message: string
  readonly upgradeHint: string
}> {}

export const HOSTING_CONTRACT_UPGRADE_HINT =
  "Update @processfocus/cli (or the hosted Backend) so their hosting-contract majors match before retrying."
