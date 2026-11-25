import { Context, Effect, Schema } from "effect"
import type { CurrentStepJobContext } from "@pf/process"
import { type XeroInvoiceError, xeroValidationError } from "./errors"
import {
  type IssueAuthorisedSalesInvoiceInput,
  IssueAuthorisedSalesInvoiceInput as IssueAuthorisedSalesInvoiceInputSchema,
  type IssuedSalesInvoice,
} from "./identities"

export { XeroInvoiceError } from "./errors"
export type {
  IssueAuthorisedSalesInvoiceInput,
  IssuedSalesInvoice,
} from "./identities"

export class XeroInvoice extends Context.Service<
  XeroInvoice,
  {
    readonly issueAuthorisedSalesInvoice: (
      input: IssueAuthorisedSalesInvoiceInput,
    ) => Effect.Effect<
      IssuedSalesInvoice,
      XeroInvoiceError,
      CurrentStepJobContext
    >
  }
>()("@processfocus/plugin-xero/XeroInvoice") {}

export const decodeIssueAuthorisedSalesInvoiceInput = (
  input: unknown,
): Effect.Effect<IssueAuthorisedSalesInvoiceInput, XeroInvoiceError> =>
  Schema.decodeUnknownEffect(IssueAuthorisedSalesInvoiceInputSchema)(
    input,
  ).pipe(
    Effect.mapError(() =>
      xeroValidationError("Sales Invoice input is invalid"),
    ),
  )
