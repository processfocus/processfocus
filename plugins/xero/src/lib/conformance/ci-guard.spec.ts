import { readFileSync } from "node:fs"
import { describe, expect, it } from "bun:test"

describe("Xero Demo Company canary CI guard", () => {
  it("keeps the live canary opt-in and out of the default test command", () => {
    const liveSpec = readFileSync(
      new URL("./demo-company.conformance.spec.ts", import.meta.url),
      { encoding: "utf8" },
    )
    const project = JSON.parse(
      readFileSync(new URL("../../../project.json", import.meta.url), {
        encoding: "utf8",
      }),
    ) as {
      targets: {
        test: { options: { command: string; env?: Record<string, string> } }
        conformance: {
          options: { command: string; env?: Record<string, string> }
        }
      }
    }

    expect(liveSpec).toContain('process.env["XERO_DEMO_CONFORMANCE"] === "1"')
    expect(liveSpec).toContain("describe.skipIf(!optedIn)")
    expect(liveSpec).toContain("XERO_CLIENT_ID")
    expect(liveSpec).toContain("XERO_CLIENT_SECRET")
    expect(project.targets.test.options.command).toBe("bun test")
    expect(project.targets.test.options.env?.["XERO_DEMO_CONFORMANCE"]).toBe(
      undefined,
    )
    expect(project.targets.conformance.options.command).toContain(
      "demo-company.conformance.spec.ts",
    )
    expect(
      project.targets.conformance.options.env?.["XERO_DEMO_CONFORMANCE"],
    ).toBe("1")
  })
})
