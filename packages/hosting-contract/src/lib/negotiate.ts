import { Effect } from "effect"
import {
  HOSTED_CAPABILITIES,
  HOSTING_CONTRACT_FORMAT,
  HOSTING_CONTRACT_FORMAT_VERSION,
  HOSTING_CONTRACT_MAJOR,
  type HostedCapability,
  type HostingContractManifest,
} from "./contract.js"
import {
  HOSTING_CONTRACT_UPGRADE_HINT,
  HostingContractParseError,
  UnsupportedHostingCapabilityError,
  UnsupportedHostingContractError,
} from "./errors.js"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Parse an untrusted value into a typed hosting-contract manifest, failing with
 * a parse error when the value is not a well-formed manifest.
 */
export const parseHostingContractManifest = (
  value: unknown,
): Effect.Effect<HostingContractManifest, HostingContractParseError> =>
  Effect.gen(function* () {
    if (!isRecord(value)) {
      return yield* new HostingContractParseError({
        message: "Hosting contract manifest must be an object",
      })
    }

    const major = value["major"]
    if (typeof major !== "number" || !Number.isInteger(major) || major < 1) {
      return yield* new HostingContractParseError({
        message: "Hosting contract major must be a positive integer",
      })
    }

    const capabilities = value["capabilities"]
    if (!Array.isArray(capabilities)) {
      return yield* new HostingContractParseError({
        message: "Hosting contract capabilities must be an array",
      })
    }

    const normalizedCapabilities: HostedCapability[] = []
    for (const capability of capabilities) {
      if (typeof capability !== "string" || capability.length === 0) {
        return yield* new HostingContractParseError({
          message: "Hosting contract capabilities must be non-empty strings",
        })
      }
      // Unknown capabilities are tolerated: same-major additions are additive,
      // and a newer Backend may advertise a capability this client does not
      // know. The client fails only on a missing capability it actually needs
      // (see assertHostingCapability).
      if (HOSTED_CAPABILITIES.includes(capability as HostedCapability)) {
        normalizedCapabilities.push(capability as HostedCapability)
      }
    }

    return {
      format: HOSTING_CONTRACT_FORMAT,
      version: HOSTING_CONTRACT_FORMAT_VERSION,
      major,
      capabilities: normalizedCapabilities,
    } satisfies HostingContractManifest
  })

/**
 * Unconditionally verify the protocol major of a typed manifest, failing with
 * upgrade guidance before any hosted mutation may be issued. This is the "fail
 * before mutation" gate for unsupported majors.
 */
export const assertSupportedHostingMajor = (
  manifest: HostingContractManifest,
): Effect.Effect<void, UnsupportedHostingContractError> =>
  manifest.major === HOSTING_CONTRACT_MAJOR
    ? Effect.void
    : Effect.fail(
        new UnsupportedHostingContractError({
          detectedMajor: manifest.major,
          supportedMajor: HOSTING_CONTRACT_MAJOR,
          message: `Backend hosting-contract major ${manifest.major} is not supported; this client implements major ${HOSTING_CONTRACT_MAJOR}.`,
          upgradeHint: HOSTING_CONTRACT_UPGRADE_HINT,
        }),
      )

/**
 * Verify that a typed manifest advertises a specific hosted capability.
 */
export const assertHostingCapability = (
  manifest: HostingContractManifest,
  capability: HostedCapability,
): Effect.Effect<void, UnsupportedHostingCapabilityError> =>
  manifest.capabilities.includes(capability)
    ? Effect.void
    : Effect.fail(
        new UnsupportedHostingCapabilityError({
          capability,
          message: `Backend hosting contract does not advertise the "${capability}" capability.`,
          upgradeHint: HOSTING_CONTRACT_UPGRADE_HINT,
        }),
      )

/**
 * Parse a Backend-reported manifest and negotiate compatibility in one step.
 *
 * @param requestedCapabilities Optional capabilities the caller needs; when
 * provided each must be advertised or the negotiation fails.
 */
export const negotiateHostingContract = (
  value: unknown,
  requestedCapabilities: readonly HostedCapability[] = [],
): Effect.Effect<
  HostingContractManifest,
  | HostingContractParseError
  | UnsupportedHostingContractError
  | UnsupportedHostingCapabilityError
> =>
  Effect.gen(function* () {
    const manifest = yield* parseHostingContractManifest(value)
    yield* assertSupportedHostingMajor(manifest)
    for (const capability of requestedCapabilities) {
      yield* assertHostingCapability(manifest, capability)
    }
    return manifest
  })
