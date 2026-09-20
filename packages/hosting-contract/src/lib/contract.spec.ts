import { describe, expect, it } from "vitest"
import {
  CONFORMANCE_FIXTURE,
  CONFORMANCE_MANIFEST,
} from "./conformance-fixture.js"
import {
  HOSTED_CAPABILITIES,
  HOSTED_OPERATIONS,
  HOSTED_OPERATION_IDS,
  HOSTING_CONTRACT_FORMAT,
  HOSTING_CONTRACT_MAJOR,
  SUPPORTED_OPERATION_IDS_BY_CAPABILITY,
} from "./contract.js"

describe("hosting contract inventory", () => {
  it("covers every hosted CLI area", () => {
    expect(HOSTED_CAPABILITIES).toEqual([
      "auth",
      "projects",
      "deploy",
      "logs",
      "database",
      "domains",
      "config",
      "stages",
      "environments",
      "role-grants",
    ])
  })

  it("assigns every operation to a declared capability", () => {
    for (const operationId of HOSTED_OPERATION_IDS) {
      const operation = HOSTED_OPERATIONS[operationId]
      expect(HOSTED_CAPABILITIES).toContain(operation.capability)
    }
  })

  it("groups every operation under its capability in the index", () => {
    for (const capability of HOSTED_CAPABILITIES) {
      for (const operationId of SUPPORTED_OPERATION_IDS_BY_CAPABILITY[
        capability
      ]) {
        expect(HOSTED_OPERATIONS[operationId].capability).toBe(capability)
      }
    }
  })

  it("exposes a conformance fixture matching the operation inventory", () => {
    expect(CONFORMANCE_FIXTURE.format).toBe(HOSTING_CONTRACT_FORMAT)
    expect(CONFORMANCE_FIXTURE.major).toBe(HOSTING_CONTRACT_MAJOR)
    expect(CONFORMANCE_FIXTURE.capabilities).toEqual([...HOSTED_CAPABILITIES])
    expect(CONFORMANCE_FIXTURE.operations).toHaveLength(
      HOSTED_OPERATION_IDS.length,
    )
    for (const operation of CONFORMANCE_FIXTURE.operations) {
      expect(
        HOSTED_OPERATIONS[operation.id as keyof typeof HOSTED_OPERATIONS],
      ).toBeDefined()
    }
  })

  it("ships a manifest a conformant Backend reports", () => {
    expect(CONFORMANCE_MANIFEST).toEqual({
      format: HOSTING_CONTRACT_FORMAT,
      version: 1,
      major: HOSTING_CONTRACT_MAJOR,
      capabilities: [...HOSTED_CAPABILITIES],
    })
  })
})
