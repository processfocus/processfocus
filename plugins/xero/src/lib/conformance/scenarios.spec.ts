import { Effect } from "effect"
import { expectSharedScenarioResults } from "./expectations"
import { createConformanceRun } from "./run-id"
import { runSharedConformanceScenarios } from "./scenarios"
import { makeTestConformanceHarness } from "./test-harness"
import { describe, expect, it } from "bun:test"

describe("Xero Demo Company shared conformance scenarios", () => {
  it("matches test-adapter assumptions for contact, tax, authorised create, replay, and validation", async () => {
    const harness = makeTestConformanceHarness()
    const run = createConformanceRun(
      Date.UTC(2026, 2, 15, 0, 0, 0),
      () => "test0001",
    )
    const results = await Effect.runPromise(
      runSharedConformanceScenarios(harness, run),
    )

    expectSharedScenarioResults(results, harness.requestedUrls())
    expect(
      await Effect.runPromise(
        harness.invoiceCountByReference(results.zeroTax.invoice.reference),
      ),
    ).toBe(1)
    expect(results.zeroTax.invoice.date).toBe(run.date)
    expect(results.gst.invoice.date).toBe(run.date)
    expect(results.zeroTax.invoice.reference).not.toBe(
      results.gst.invoice.reference,
    )
  })
})
