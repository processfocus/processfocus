import { DateTime, Effect, Layer, Redacted, Result } from "effect"
import { FetchHttpClient } from "effect/http"
import {
  Organisation,
  Process,
  buildFlowContext,
  makeSystemStepExecutor,
} from "@pf/process"
import {
  XeroInvoiceCancellationStep,
  decodeCancelSalesInvoiceInput,
} from "../index"
import { XeroInvoiceCancellationLive, XeroInvoiceConfig } from "../runtime"
import { describe, expect, it } from "bun:test"

const invoiceId = "22222222-2222-4222-8222-222222222222"
const tenantId = "11111111-1111-4111-8111-111111111111"
const invoiceUrl = `https://api.xero.com/api.xro/2.0/Invoices/${invoiceId}`

describe("Sales Invoice cancellation through the process executor", () => {
  for (const loseResponse of [false, true]) {
    it(`confirms the stored invoice and safely replays (${loseResponse ? "lost" : "received"} response)`, async () => {
      const requests: {
        method: string
        url: string
        body: string
        headers: Headers
      }[] = []
      let status = "AUTHORISED"
      const org = new Organisation({ name: "Cancellation test" })
      const process = new Process(org, "Cancel", {
        name: "Cancel",
        purpose: "Cancel stored invoice",
      })
      const step = new XeroInvoiceCancellationStep<{ storedInvoiceId: string }>(
        process,
        "Cancel invoice",
        {
          input: (state) =>
            decodeCancelSalesInvoiceInput({ invoiceId: state.storedInvoiceId }),
        },
      )
      process.start(step).end()
      const executor = makeSystemStepExecutor(org)
      const fetchBoundary = async (
        url: string | URL | Request,
        init?: RequestInit,
      ) => {
        const request =
          url instanceof Request
            ? url
            : new Request(url instanceof URL ? url.toString() : url, init)
        const body = await request.text()
        requests.push({
          method: request.method,
          url: request.url,
          body,
          headers: request.headers,
        })
        if (request.url === "https://identity.xero.com/connect/token")
          return Response.json({
            access_token: "test-token",
            token_type: "Bearer",
            expires_in: 1800,
          })
        if (request.url === "https://api.xero.com/connections")
          return Response.json([{ tenantId, tenantType: "ORGANISATION" }])
        expect(request.url).toBe(invoiceUrl)
        if (request.method === "POST") {
          expect(JSON.parse(body)).toEqual({
            Invoices: [{ InvoiceID: invoiceId, Status: "VOIDED" }],
          })
          status = "VOIDED"
          if (loseResponse)
            throw new TypeError("Connection lost after provider commit")
        }
        return Response.json({
          Invoices: [
            {
              InvoiceID: invoiceId,
              InvoiceNumber: "INV-0100",
              Type: "ACCREC",
              Status: status,
            },
          ],
        })
      }
      const live = XeroInvoiceCancellationLive.pipe(
        Layer.provide(
          Layer.succeed(XeroInvoiceConfig, {
            clientId: "test-client",
            clientSecret: Redacted.make("test-secret"),
            scopes: "accounting.invoices",
          }),
        ),
        Layer.provide(
          FetchHttpClient.layer.pipe(
            Layer.provide(
              Layer.succeed(
                FetchHttpClient.Fetch,
                Object.assign(fetchBoundary, { preconnect: () => {} }),
              ),
            ),
          ),
        ),
      )
      const run = () =>
        executor.execute(
          step.node.path,
          {
            storedInvoiceId: invoiceId,
            originalAccountingReference: "INV-0100",
          },
          buildFlowContext("pex-cancel", DateTime.nowUnsafe(), []),
          "todo-cancel",
        )
      // The SDK deliberately erases organisation-specific service requirements.
      const first = await Effect.runPromise(
        Effect.result(run().pipe(Effect.provide(live))) as Effect.Effect<
          Result.Result<unknown, unknown>
        >,
      )
      if (loseResponse) {
        expect(Result.isFailure(first)).toBe(true)
        if (Result.isFailure(first))
          expect(first.failure).toMatchObject({ retryable: true })
      } else {
        expect(Result.isSuccess(first)).toBe(true)
        if (Result.isSuccess(first))
          expect(first.success).toEqual({
            _tag: "Completed",
            output: { invoiceId, invoiceNumber: "INV-0100", status: "VOIDED" },
          })
      }
      // Rebuild the live layer: recovery must not depend on local memory or a cached POST.
      const replay = await Effect.runPromise(
        run().pipe(Effect.provide(live)) as Effect.Effect<unknown, unknown>,
      )
      expect(replay).toEqual({
        _tag: "Completed",
        output: { invoiceId, invoiceNumber: "INV-0100", status: "VOIDED" },
      })
      const accounting = requests.filter(
        (request) => request.url === invoiceUrl,
      )
      expect(accounting.map((request) => request.method)).toEqual([
        "GET",
        "POST",
        "GET",
      ])
      for (const request of accounting) {
        expect(request.headers.get("authorization")).toBe("Bearer test-token")
        expect(request.headers.get("xero-tenant-id")).toBe(tenantId)
      }
      expect(accounting[1]?.headers.get("idempotency-key")).toMatch(
        /^pf-invoice-void:/,
      )
    })
  }
})
