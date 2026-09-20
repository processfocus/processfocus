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

export class XeroInvoice extends Context.Tag(
  "@processfocus/plugin-xero/XeroInvoice",
)<
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
>() {}

export const decodeIssueAuthorisedSalesInvoiceInput = (
  input: unknown,
): Effect.Effect<IssueAuthorisedSalesInvoiceInput, XeroInvoiceError> =>
  Schema.decodeUnknown(IssueAuthorisedSalesInvoiceInputSchema)(input).pipe(
    Effect.mapError(() =>
      xeroValidationError("Sales Invoice input is invalid"),
    ),
  )
