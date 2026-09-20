import { HttpClient, HttpClientResponse } from "@effect/platform"
import { ConfigProvider, Effect, Layer } from "effect"
import {
  XeroInvoiceConfigFromEnv,
  XeroInvoiceLookupLive,
} from "./xero-invoice-live"
import { XeroInvoiceLookup } from "./xero-invoice-lookup"
import { describe, expect, it } from "bun:test"

const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`
const contact = (n: number) => ({
  ContactID: id(n),
  Name: `Contact ${n}`,
  ContactStatus: "ACTIVE",
  EmailAddress: " PARENT@EXAMPLE.COM ",
  ContactPersons: [
    { EmailAddress: "other@example.com", IncludeInEmails: true },
    { EmailAddress: "disabled@example.com", IncludeInEmails: false },
  ],
})
const invoice = (n: number) => ({
  InvoiceID: id(n),
  InvoiceNumber: `INV-${n}`,
  Type: "ACCREC",
  Status: "AUTHORISED",
  Contact: { ContactID: id(1) },
  Reference: "T4 2026 Pupil Y11",
})
const run = (
  response: (url: URL) => Response,
  requests: string[] = [],
  previousReference?: string,
) => {
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push(`${request.method} ${request.url}`)
        const url = new URL(request.url)
        const result =
          url.pathname === "/connect/token"
            ? Response.json({
                access_token: "fixture",
                token_type: "Bearer",
                expires_in: 1800,
              })
            : url.pathname === "/connections"
              ? Response.json([{ tenantId: "fixture" }])
              : response(url)
        return HttpClientResponse.fromWeb(request, result)
      }),
    ),
  )
  return Effect.runPromise(
    Effect.gen(function* () {
      const lookup = yield* XeroInvoiceLookup
      return yield* lookup.readDirectory("T4 2026", previousReference)
    }).pipe(
      Effect.provide(
        XeroInvoiceLookupLive.pipe(
          Layer.provide(XeroInvoiceConfigFromEnv),
          Layer.provide(http),
        ),
      ),
      Effect.withConfigProvider(
        ConfigProvider.fromMap(
          new Map([
            ["XERO_CLIENT_ID", "fixture"],
            ["XERO_CLIENT_SECRET", "fixture"],
          ]),
        ),
      ),
    ),
  )
}

describe("Xero invoice directory", () => {
  it("reads all contact/invoice pages including additional contact-person emails, using only GET accounting calls", async () => {
    const requests: string[] = []
    const result = await run((url) => {
      const page = Number(url.searchParams.get("page"))
      expect(url.searchParams.get("pageSize")).toBe("100")
      if (url.pathname.endsWith("/Contacts")) {
        expect(url.searchParams.get("includeArchived")).toBe("true")
        return Response.json({
          Contacts:
            page === 1
              ? Array.from({ length: 100 }, (_, index) => contact(index + 1))
              : [contact(101)],
        })
      }
      expect(url.searchParams.get("where")).toBe(
        'Type=="ACCREC"&&(Reference.Contains("T4 2026"))',
      )
      expect(url.searchParams.get("Statuses")).toBe(
        "DRAFT,SUBMITTED,AUTHORISED,PAID,VOIDED,DELETED",
      )
      return Response.json({
        Invoices:
          page === 1
            ? Array.from({ length: 100 }, (_, index) => invoice(index + 1))
            : [invoice(101)],
      })
    }, requests)
    expect(result.contacts).toHaveLength(101)
    expect(result.invoices).toHaveLength(101)
    expect(result.contacts[0]?.emails).toEqual([
      "parent@example.com",
      "other@example.com",
      "disabled@example.com",
    ])
    expect(result.contacts[0]?.invoiceRecipientEmails).toEqual([
      "parent@example.com",
      "other@example.com",
    ])
    expect(requests.filter((request) => request.startsWith("POST"))).toEqual([
      "POST https://identity.xero.com/connect/token",
    ])
  })

  it("loads the previous reference with the current reference without rereading contacts", async () => {
    const requests: string[] = []
    await run(
      (url) => {
        if (url.pathname.endsWith("/Contacts"))
          return Response.json({ Contacts: [] })
        expect(url.searchParams.get("where")).toBe(
          'Type=="ACCREC"&&(Reference.Contains("T4 2026")||Reference.Contains("T3 2026"))',
        )
        return Response.json({ Invoices: [] })
      },
      requests,
      "T3 2026",
    )
    expect(
      requests.filter((request) => request.includes("/Contacts?")),
    ).toHaveLength(1)
    expect(
      requests.filter((request) => request.includes("/Invoices?")),
    ).toHaveLength(1)
  })

  it("rejects repeated pages rather than declaring the lookup complete", async () => {
    await expect(
      run(() =>
        Response.json({
          Contacts: Array.from({ length: 100 }, (_, index) =>
            contact(index + 1),
          ),
        }),
      ),
    ).rejects.toThrow("Repeated")
  })

  it.each([401, 403, 500, 206])(
    "never treats HTTP %s as an empty directory",
    async (status) => {
      await expect(run(() => new Response("{}", { status }))).rejects.toThrow()
    },
  )

  it("rejects missing required invoice identity fields", async () => {
    await expect(
      run((url) =>
        url.pathname.endsWith("/Contacts")
          ? Response.json({ Contacts: [] })
          : Response.json({ Invoices: [{ ...invoice(1), Contact: {} }] }),
      ),
    ).rejects.toThrow("Malformed")
  })

  it("rejects an unrelated payload instead of reporting no invoices", async () => {
    await expect(
      run((url) =>
        url.pathname.endsWith("/Contacts")
          ? Response.json({ Contacts: [] })
          : Response.json({ Error: "Unavailable" }),
      ),
    ).rejects.toThrow("Malformed")
  })

  it("rejects a partial response even with HTTP 200", async () => {
    await expect(
      run(() =>
        Response.json(
          { Contacts: [] },
          {
            headers: { "Content-Range": "items 0-0/100" },
          },
        ),
      ),
    ).rejects.toThrow("Incomplete")
  })
})
