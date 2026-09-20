import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Cause, Effect, Exit, Layer, Option } from "effect"
import { Organisation, OrganisationProviderTest } from "@pf/process"
import {
  CedarPoliciesDirNotFoundError,
  CedarPoliciesProvider,
  OrgCedarPoliciesProvider,
  PoliciesConfig,
  StaticCedarPoliciesProvider,
  extractPolicyFiles,
} from "../src"
import { afterEach, beforeEach, describe, expect, it } from "bun:test"

describe("extractPolicyFiles", () => {
  it("returns empty array for organisation without PoliciesConfig", () => {
    const org = new Organisation({ name: "Test Org" })

    const result = extractPolicyFiles(org)

    expect(result).toEqual([])
  })

  it("returns policy files from organisation with PoliciesConfig", () => {
    const org = new Organisation({ name: "Test Org" })
    new PoliciesConfig(org, "policies", {
      policyFiles: ["cedar/custom.cedar", "cedar/admin.cedar"],
    })

    const result = extractPolicyFiles(org)

    expect(result).toEqual(["cedar/custom.cedar", "cedar/admin.cedar"])
  })

  it("collects policy files from multiple PoliciesConfig constructs", () => {
    const org = new Organisation({ name: "Test Org" })
    new PoliciesConfig(org, "base-policies", {
      policyFiles: ["cedar/base.cedar"],
    })
    new PoliciesConfig(org, "admin-policies", {
      policyFiles: ["cedar/admin.cedar", "cedar/superuser.cedar"],
    })

    const result = extractPolicyFiles(org)

    expect(result).toEqual([
      "cedar/base.cedar",
      "cedar/admin.cedar",
      "cedar/superuser.cedar",
    ])
  })
})

describe("OrgCedarPoliciesProvider", () => {
  it("provides absolute paths from organisation", async () => {
    const org = new Organisation({ name: "Test Org" })
    new PoliciesConfig(org, "policies", {
      policyFiles: ["cedar/custom.cedar"],
    })

    const testOrgPath = "/some/org/path"
    const OrgProviderLayer = OrganisationProviderTest(org, testOrgPath)

    const CedarProviderLayer = OrgCedarPoliciesProvider.pipe(
      Layer.provide(OrgProviderLayer),
    )

    const result = await Effect.runPromise(
      CedarPoliciesProvider.pipe(Effect.provide(CedarProviderLayer)),
    )

    expect(result.policyPaths).toEqual(["/some/org/path/cedar/custom.cedar"])
  })

  it("returns empty array when no policies configured", async () => {
    const org = new Organisation({ name: "Test Org" })
    const testOrgPath = "/some/org/path"
    const OrgProviderLayer = OrganisationProviderTest(org, testOrgPath)

    const CedarProviderLayer = OrgCedarPoliciesProvider.pipe(
      Layer.provide(OrgProviderLayer),
    )

    const result = await Effect.runPromise(
      CedarPoliciesProvider.pipe(Effect.provide(CedarProviderLayer)),
    )

    expect(result.policyPaths).toEqual([])
  })
})

describe("StaticCedarPoliciesProvider", () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cedar-test-"))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it("reads single .cedar file from CEDAR_PATH", async () => {
    fs.writeFileSync(path.join(tempDir, "policy.cedar"), "permit(...);\n")

    const originalEnv = process.env["CEDAR_PATH"]
    process.env["CEDAR_PATH"] = tempDir

    try {
      const result = await Effect.runPromise(
        CedarPoliciesProvider.pipe(Effect.provide(StaticCedarPoliciesProvider)),
      )

      expect(result.policyPaths).toEqual([path.join(tempDir, "policy.cedar")])
    } finally {
      if (originalEnv !== undefined) {
        process.env["CEDAR_PATH"] = originalEnv
      } else {
        delete process.env["CEDAR_PATH"]
      }
    }
  })

  it("reads multiple .cedar files from CEDAR_PATH", async () => {
    fs.writeFileSync(path.join(tempDir, "policy1.cedar"), "permit(...);\n")
    fs.writeFileSync(path.join(tempDir, "policy2.cedar"), "forbid(...);\n")
    // Non-cedar file should be ignored
    fs.writeFileSync(path.join(tempDir, "readme.txt"), "Not a policy\n")

    const originalEnv = process.env["CEDAR_PATH"]
    process.env["CEDAR_PATH"] = tempDir

    try {
      const result = await Effect.runPromise(
        CedarPoliciesProvider.pipe(Effect.provide(StaticCedarPoliciesProvider)),
      )

      expect(result.policyPaths).toHaveLength(2)
      expect(result.policyPaths).toContain(path.join(tempDir, "policy1.cedar"))
      expect(result.policyPaths).toContain(path.join(tempDir, "policy2.cedar"))
    } finally {
      if (originalEnv !== undefined) {
        process.env["CEDAR_PATH"] = originalEnv
      } else {
        delete process.env["CEDAR_PATH"]
      }
    }
  })

  it("reads .cedarschema files from CEDAR_PATH", async () => {
    fs.writeFileSync(
      path.join(tempDir, "schema.cedarschema"),
      "namespace PF {}",
    )
    fs.writeFileSync(
      path.join(tempDir, "custom.cedarschema"),
      "namespace Org {}",
    )

    const originalEnv = process.env["CEDAR_PATH"]
    process.env["CEDAR_PATH"] = tempDir

    try {
      const result = await Effect.runPromise(
        CedarPoliciesProvider.pipe(Effect.provide(StaticCedarPoliciesProvider)),
      )

      expect(result.schemaPaths).toHaveLength(2)
      expect(result.schemaPaths).toContain(
        path.join(tempDir, "schema.cedarschema"),
      )
      expect(result.schemaPaths).toContain(
        path.join(tempDir, "custom.cedarschema"),
      )
    } finally {
      if (originalEnv !== undefined) {
        process.env["CEDAR_PATH"] = originalEnv
      } else {
        delete process.env["CEDAR_PATH"]
      }
    }
  })

  it("returns empty array when directory has no .cedar files", async () => {
    // Create only non-cedar files
    fs.writeFileSync(path.join(tempDir, "readme.txt"), "Not a policy\n")

    const originalEnv = process.env["CEDAR_PATH"]
    process.env["CEDAR_PATH"] = tempDir

    try {
      const result = await Effect.runPromise(
        CedarPoliciesProvider.pipe(Effect.provide(StaticCedarPoliciesProvider)),
      )

      expect(result.policyPaths).toEqual([])
    } finally {
      if (originalEnv !== undefined) {
        process.env["CEDAR_PATH"] = originalEnv
      } else {
        delete process.env["CEDAR_PATH"]
      }
    }
  })

  it("fails with CedarPoliciesDirNotFoundError when directory does not exist", async () => {
    const nonExistentDir = path.join(tempDir, "does-not-exist")

    const originalEnv = process.env["CEDAR_PATH"]
    process.env["CEDAR_PATH"] = nonExistentDir

    try {
      const exit = await Effect.runPromiseExit(
        CedarPoliciesProvider.pipe(Effect.provide(StaticCedarPoliciesProvider)),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const errorOption = Cause.failureOption(exit.cause)
        expect(Option.isSome(errorOption)).toBe(true)
        if (Option.isSome(errorOption)) {
          expect(errorOption.value).toBeInstanceOf(
            CedarPoliciesDirNotFoundError,
          )
          if (errorOption.value instanceof CedarPoliciesDirNotFoundError) {
            expect(errorOption.value.path).toBe(nonExistentDir)
          }
        }
      }
    } finally {
      if (originalEnv !== undefined) {
        process.env["CEDAR_PATH"] = originalEnv
      } else {
        delete process.env["CEDAR_PATH"]
      }
    }
  })
})
