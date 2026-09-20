import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { CONFORMANCE_MANIFEST } from "./conformance-fixture.js"
import {
  HOSTING_CONTRACT_UPGRADE_HINT,
  HostingContractParseError,
  UnsupportedHostingCapabilityError,
  UnsupportedHostingContractError,
} from "./errors.js"
import {
  assertHostingCapability,
  assertSupportedHostingMajor,
  negotiateHostingContract,
  parseHostingContractManifest,
} from "./negotiate.js"

const decode = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(Effect.flip, Effect.runPromise)

describe("hosting contract negotiation", () => {
  it("parses a fully-capable Backend manifest", async () => {
    const manifest = await Effect.runPromise(
      parseHostingContractManifest(CONFORMANCE_MANIFEST),
    )
    expect(manifest.capabilities).toContain("deploy")
    expect(manifest.capabilities).toContain("role-grants")
  })

  it("tolerates an unknown capability from a newer same-major Backend", async () => {
    const manifest = await Effect.runPromise(
      parseHostingContractManifest({
        format: "processfocus/hosting-contract",
        version: 1,
        major: 1,
        capabilities: ["auth", "billing"],
      }),
    )
    expect(manifest.capabilities).toEqual(["auth"])
  })

  it("rejects a non-string capability entry", async () => {
    const error = await decode(
      parseHostingContractManifest({
        format: "processfocus/hosting-contract",
        version: 1,
        major: 1,
        capabilities: [42],
      }),
    )
    expect(error).toBeInstanceOf(HostingContractParseError)
    expect(error.message).toContain("non-empty strings")
  })

  it("rejects a missing capabilities array", async () => {
    const error = await decode(
      parseHostingContractManifest({
        format: "processfocus/hosting-contract",
        version: 1,
        major: 1,
      }),
    )
    expect(error).toBeInstanceOf(HostingContractParseError)
  })

  it("fails before mutation when the major is unsupported, with upgrade guidance", async () => {
    const manifest = await Effect.runPromise(
      parseHostingContractManifest({
        ...CONFORMANCE_MANIFEST,
        major: 2,
      }),
    )
    const error = await decode(assertSupportedHostingMajor(manifest))
    expect(error).toBeInstanceOf(UnsupportedHostingContractError)
    expect(error.detectedMajor).toBe(2)
    expect(error.upgradeHint).toBe(HOSTING_CONTRACT_UPGRADE_HINT)
  })

  it("fails when a requested capability is not advertised", async () => {
    const manifest = await Effect.runPromise(
      parseHostingContractManifest({
        ...CONFORMANCE_MANIFEST,
        capabilities: ["auth", "projects"],
      }),
    )
    const error = await decode(assertHostingCapability(manifest, "deploy"))
    expect(error).toBeInstanceOf(UnsupportedHostingCapabilityError)
    expect(error.capability).toBe("deploy")
  })

  it("negotiates against an additive same-major Backend", async () => {
    const manifest = await Effect.runPromise(
      negotiateHostingContract(CONFORMANCE_MANIFEST, ["deploy", "role-grants"]),
    )
    expect(manifest.major).toBe(1)
  })

  it("negotiates against a minimal same-major Backend without extra capabilities", async () => {
    const manifest = await Effect.runPromise(
      negotiateHostingContract(
        {
          format: "processfocus/hosting-contract",
          version: 1,
          major: 1,
          capabilities: ["projects"],
        },
        ["projects"],
      ),
    )
    expect(manifest.capabilities).toEqual(["projects"])
  })
})
