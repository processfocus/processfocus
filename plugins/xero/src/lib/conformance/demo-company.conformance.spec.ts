import { FetchHttpClient } from "@effect/platform"
import { Effect, Layer, Logger } from "effect"
import { XeroInvoiceConfigFromEnv } from "../xero-invoice-live"
import { CONFORMANCE_SHIPPING_LINE1 } from "./catalog"
import { containsProhibitedDiagnostics, evidenceJson } from "./evidence"
import { expectSharedScenarioResults } from "./expectations"
import { makeLiveConformanceHarness } from "./live-harness"
import { createConformanceRun } from "./run-id"
import { runSharedConformanceScenarios } from "./scenarios"
import { afterEach, describe, expect, it } from "bun:test"

const optedIn = process.env["XERO_DEMO_CONFORMANCE"] === "1"

const requireCustomConnectionCredentials = (): void => {
  const clientId = process.env["XERO_CLIENT_ID"]?.trim() ?? ""
  const clientSecret = process.env["XERO_CLIENT_SECRET"]?.trim() ?? ""
  if (clientId === "" || clientSecret === "") {
    throw new Error(
      "Xero Demo Company conformance requires XERO_CLIENT_ID and XERO_CLIENT_SECRET for a dedicated Demo Company Custom Connection",
    )
  }
}

describe.skipIf(!optedIn)("Xero Demo Company live conformance", () => {
  const originalFetch = globalThis.fetch
  const requestedUrls: string[] = []

  afterEach(() => {
    globalThis.fetch = originalFetch
    requestedUrls.length = 0
  })

  it("compares live Demo Company behavior with test-adapter assumptions", async () => {
    requireCustomConnectionCredentials()
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const request =
        input instanceof Request
          ? input
          : new Request(input instanceof URL ? input.toString() : input, init)
      requestedUrls.push(request.url)
      return originalFetch(request)
    }) as typeof fetch

    const logs: string[] = []
    const capturingLogger = Logger.make(({ message, annotations }) => {
      logs.push(
        `${String(message)} ${JSON.stringify(Object.fromEntries(annotations))}`,
      )
    })

    const harness = await Effect.runPromise(
      makeLiveConformanceHarness(requestedUrls).pipe(
        Effect.provide(
          Layer.provideMerge(XeroInvoiceConfigFromEnv, FetchHttpClient.layer),
        ),
      ),
    )

    const results = await Effect.runPromise(
      runSharedConformanceScenarios(harness, createConformanceRun()).pipe(
        Effect.provide(Logger.replace(Logger.defaultLogger, capturingLogger)),
      ),
    )

    expectSharedScenarioResults(results, requestedUrls)
    expect(
      await Effect.runPromise(
        harness.invoiceCountByReference(results.zeroTax.invoice.reference),
      ),
    ).toBe(1)
    expect(
      await Effect.runPromise(
        harness.invoiceCountByReference(results.gst.invoice.reference),
      ),
    ).toBe(1)

    const evidence = evidenceJson({
      results,
      urls: requestedUrls,
      logs,
    })
    expect(containsProhibitedDiagnostics(evidence)).toBe(false)
    expect(evidence).not.toContain(CONFORMANCE_SHIPPING_LINE1)
    const combinedLogs = logs.join("\n")
    expect(combinedLogs).not.toContain(CONFORMANCE_SHIPPING_LINE1)
    expect(combinedLogs).not.toContain("Bearer ")
  }, 120_000)
})
