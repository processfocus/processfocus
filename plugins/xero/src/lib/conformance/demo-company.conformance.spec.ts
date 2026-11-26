import { Effect, Layer, Logger, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { IssueAuthorisedSalesInvoiceInput } from "../identities"
import { XeroInvoiceConfigFromEnv } from "../xero-invoice-live"
import { CONFORMANCE_SHIPPING_LINE1, catalogItemCodes } from "./catalog"
import { containsProhibitedDiagnostics, evidenceJson } from "./evidence"
import { expectSharedScenarioResults } from "./expectations"
import { makeLiveConformanceHarness } from "./live-harness"
import {
  createConformanceRun,
  uniqueCustomerEmail,
  uniqueCustomerName,
  uniqueOrderNumberReference,
  uniqueTodoId,
} from "./run-id"
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

  it("persists billing fallback on creation and update, preserves partial billing, and populates invoice contact addresses", async () => {
    requireCustomConnectionCredentials()
    const harness = await Effect.runPromise(
      makeLiveConformanceHarness([]).pipe(
        Effect.provide(
          Layer.provideMerge(XeroInvoiceConfigFromEnv, FetchHttpClient.layer),
        ),
      ),
    )
    const run = createConformanceRun()
    const input = Schema.decodeUnknownSync(IssueAuthorisedSalesInvoiceInput)({
      customer: {
        name: uniqueCustomerName(run, "Billing"),
        email: uniqueCustomerEmail(run, "Billing"),
      },
      shippingAddress: {
        line1: CONFORMANCE_SHIPPING_LINE1,
        line2: "Synthetic Suite 2",
        city: "Wellington",
        region: "Wellington",
        postalCode: "6011",
        country: "New Zealand",
      },
      lines: [
        {
          productSku: catalogItemCodes().zeroTax,
          quantity: 1,
          unitAmount: "100.00",
        },
      ],
      currency: "NZD",
      reference: uniqueOrderNumberReference(run, "BA"),
      date: run.date,
      dueDate: run.date,
    })
    const street = {
      AddressType: "STREET" as const,
      AddressLine1: CONFORMANCE_SHIPPING_LINE1,
      AddressLine2: "Synthetic Suite 2",
      City: "Wellington",
      Region: "Wellington",
      PostalCode: "6011",
      Country: "New Zealand",
    }
    const created = await Effect.runPromise(
      harness.issue(input, uniqueTodoId(run, "ba")),
    )
    if (created.kind !== "issued")
      throw new Error(`Billing creation failed: ${created.failed.code}`)
    const contactId = created.issued.invoice.contactId
    const first = await Effect.runPromise(
      harness.readContactAddresses(contactId),
    )
    expect(
      first.find((address) => address.AddressType === "STREET"),
    ).toMatchObject(street)
    expect(
      first.find((address) => address.AddressType === "POBOX"),
    ).toMatchObject({ ...street, AddressType: "POBOX" })
    expect(
      (
        await Effect.runPromise(
          harness.readInvoiceAddresses(created.issued.invoiceId),
        )
      ).find((address) => address.AddressType === "POBOX"),
    ).toMatchObject({ ...street, AddressType: "POBOX" })

    // Model a pre-existing contact that has delivery but no billing details.
    await Effect.runPromise(
      harness.setContactAddresses(contactId, [
        {
          AddressType: "POBOX",
          AddressLine1: "",
          AddressLine2: "",
          AddressLine3: "",
          AddressLine4: "",
          AttentionTo: "",
          City: "",
          Region: "",
          PostalCode: "",
          Country: "",
        },
      ]),
    )
    expect(
      (await Effect.runPromise(harness.readContactAddresses(contactId)))
        .filter((address) => address.AddressType === "POBOX")
        .every(({ AddressType: _type, ...content }) =>
          Object.values(content).every((value) => !value?.trim()),
        ),
    ).toBe(true)
    const updatedInput = Schema.decodeUnknownSync(
      IssueAuthorisedSalesInvoiceInput,
    )({
      ...input,
      reference: uniqueOrderNumberReference(run, "BU"),
      shippingAddress: {
        ...input.shippingAddress,
        line1: "2 Synthetic Shipping Street",
      },
    })
    const updated = await Effect.runPromise(
      harness.issue(updatedInput, uniqueTodoId(run, "bu")),
    )
    if (updated.kind !== "issued")
      throw new Error(`Billing update failed: ${updated.failed.code}`)
    expect(updated.issued.invoice.contactId).toBe(contactId)
    const second = await Effect.runPromise(
      harness.readContactAddresses(contactId),
    )
    for (const type of ["STREET", "POBOX"])
      expect(
        second.find((address) => address.AddressType === type),
      ).toMatchObject({
        ...street,
        AddressType: type,
        AddressLine1: "2 Synthetic Shipping Street",
      })
    expect(
      (
        await Effect.runPromise(
          harness.readInvoiceAddresses(updated.issued.invoiceId),
        )
      ).find((address) => address.AddressType === "POBOX")?.AddressLine1,
    ).toBe("2 Synthetic Shipping Street")

    await Effect.runPromise(
      harness.setContactAddresses(contactId, [
        {
          AddressType: "POBOX",
          AttentionTo: "Synthetic Accounts",
          AddressLine1: "",
          AddressLine2: "",
          AddressLine3: "",
          AddressLine4: "",
          City: "",
          Region: "",
          PostalCode: "",
          Country: "",
        },
      ]),
    )
    const billing = (
      await Effect.runPromise(harness.readContactAddresses(contactId))
    ).find((address) => address.AddressType === "POBOX")
    const preservedInput = Schema.decodeUnknownSync(
      IssueAuthorisedSalesInvoiceInput,
    )({
      ...input,
      reference: uniqueOrderNumberReference(run, "BP"),
      shippingAddress: {
        ...input.shippingAddress,
        line1: "3 Synthetic Shipping Street",
      },
    })
    const preserved = await Effect.runPromise(
      harness.issue(preservedInput, uniqueTodoId(run, "bp")),
    )
    if (preserved.kind !== "issued")
      throw new Error(`Billing preservation failed: ${preserved.failed.code}`)
    const third = await Effect.runPromise(
      harness.readContactAddresses(contactId),
    )
    expect(third.find((address) => address.AddressType === "POBOX")).toEqual(
      billing,
    )
    expect(
      third.find((address) => address.AddressType === "STREET")?.AddressLine1,
    ).toBe("3 Synthetic Shipping Street")
    expect(
      await Effect.runPromise(
        harness.invoiceCountByReference(preservedInput.reference),
      ),
    ).toBe(1)
  }, 120_000)

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
    const capturingLogger = Logger.make((options) => {
      const { message, annotations } = Logger.formatStructured.log(options)
      logs.push(`${String(message)} ${JSON.stringify(annotations)}`)
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
        Effect.provide(Logger.layer([capturingLogger])),
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
