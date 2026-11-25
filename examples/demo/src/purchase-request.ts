import { and, eq } from "drizzle-orm"
import { Schema as ES, Effect } from "effect"
import { searchLookupItems } from "@pf/form-schema"
import {
  Form,
  FormSubmissionError,
  NodeStep,
  type OrgUnit,
  Process,
  type Role,
  Sla,
} from "@pf/process"
import {
  purchaseApprovalForm,
  purchaseRequestForm,
} from "./purchase-request-form"
import { procurementApprovalForm, purchaseForm } from "./purchase-request-forms"
import { DemoOperations } from "./schema"
import { purchaseOrder } from "./schema/schema"
import { TypedDemoDrizzle } from "./schema/typed-drizzle"

export class PurchaseRequest extends Process {
  constructor(
    scope: OrgUnit,
    id: string,
    employeeRole: Role,
    managerRole: Role,
    procurementRole: Role,
  ) {
    super(scope, id, {
      name: "Purchase Request",
      purpose: "Request and approve purchases over $500",
      sla: Sla.businessWeeks(1), // Overall process must complete in 1 business week
    })

    const submit_request = new Form(this, "Submit request", {
      name: "Submit purchase request",
      form: purchaseRequestForm,
      browser: {
        entrypoint: "src/purchase-request-form.ts",
        exportName: "purchaseRequestForm",
      },
      onSubmit: (input) =>
        Effect.gen(function* () {
          const db = yield* TypedDemoDrizzle
          const existing = yield* db
            .select({ id: purchaseOrder.id })
            .from(purchaseOrder)
            .where(
              and(
                eq(purchaseOrder.item, input.item),
                eq(purchaseOrder._deleted, false),
              ),
            )
            .limit(1)
            .pipe(
              Effect.mapError(
                () =>
                  new FormSubmissionError({
                    field: "item",
                    message:
                      "Could not check existing purchases. Please try again.",
                  }),
              ),
            )
          if (existing.length > 0)
            return yield* new FormSubmissionError({
              field: "item",
              message:
                "This item has already been purchased. Choose a different item.",
            })
        }),
      role: employeeRole,
    })

    submit_request.lookups.referenceOrderId.setQuery(({ filter }, limit) =>
      Effect.gen(function* () {
        const db = yield* TypedDemoDrizzle
        const orders = yield* db
          .select({ value: purchaseOrder.id, label: purchaseOrder.item })
          .from(purchaseOrder)
          .where(eq(purchaseOrder._deleted, false))
          .orderBy(purchaseOrder.id)
        return searchLookupItems(orders, filter, limit)
      }),
    )
    submit_request.lookups.referenceOrderId.setResolver((value) =>
      Effect.gen(function* () {
        const db = yield* TypedDemoDrizzle
        const orders = yield* db
          .select({ value: purchaseOrder.id, label: purchaseOrder.item })
          .from(purchaseOrder)
          .where(
            and(eq(purchaseOrder.id, value), eq(purchaseOrder._deleted, false)),
          )
          .limit(1)
        return orders[0] ?? null
      }),
    )

    // Start the flow to capture accumulated state
    const flow = this.start(submit_request)

    // new Form with flow scope infers state type automatically
    const manager_approve_request = new Form(flow, "Manager approval", {
      name: "Approve purchase request",
      form: purchaseApprovalForm,
      browser: {
        entrypoint: "src/purchase-request-form.ts",
        exportName: "purchaseApprovalForm",
      },
      bindings: (state) => ({
        item: { default: state.item },
        cost: { default: String(state.value) },
      }),
      summary: (state) => ({ What: `${state.item} for ${state.value}` }),
      role: managerRole,
      sla: Sla.businessDays(2), // Manager has 2 business days to approve
    })

    const managerFlow = flow.next(manager_approve_request)

    const cfo_approve_request = new Form(managerFlow, "Procurement approval", {
      name: "Approve expensive purchase request",
      form: procurementApprovalForm,
      browser: {
        entrypoint: "src/purchase-request-forms.ts",
        exportName: "procurementApprovalForm",
      },
      summary: (state, context) => ({
        What: `${state.item} for ${state.value}`,
        "Approved by": context.step.managerApproval.providerUser.name,
      }),
      role: procurementRole,
      sla: Sla.businessDays(1), // Procurement has 1 business day
    })

    // NodeStep to generate purchase order number
    const generate_po = new NodeStep(managerFlow, "Generate PO", {
      name: "Generate purchase order number",
      input: (state) =>
        Effect.succeed({ item: state.item, value: state.value }),
      output: { purchaseNumber: ES.String },
      execute: (_input) =>
        Effect.succeed({
          purchaseNumber: `PO-${Math.random().toString(36).substring(2, 10).toUpperCase()}`,
        }),
    })

    // CFO approval for purchases >= 1000
    const cfoFlow = managerFlow.next(cfo_approve_request, {
      condition: {
        fn: (state) => state.value >= 1000,
        text: "Value >= $1000",
      },
    })
    cfoFlow.next(generate_po)
    // Else path goes directly to generate_po; this FlowPath includes purchaseNumber in state
    const generatePoFlow = managerFlow.elseNext(generate_po)

    // Purchase form for procurement to execute the purchase
    // Scoped to generatePoFlow which has purchaseNumber in state
    const purchase = new Form(generatePoFlow, "Purchase", {
      name: "Execute purchase",
      form: purchaseForm,
      browser: {
        entrypoint: "src/purchase-request-forms.ts",
        exportName: "purchaseForm",
      },
      summary: (state) => ({
        Item: state.item,
        Value: String(state.value),
        "Purchase Order": state.purchaseNumber,
      }),
      role: procurementRole,
      sla: Sla.businessDays(1),
    })

    // System step to save purchase order to database
    const savePurchaseOrder = new NodeStep(
      generatePoFlow,
      "SavePurchaseOrder",
      {
        name: "Save purchase order to database",
        input: (state) =>
          Effect.succeed({
            item: state.item,
            price: state.value,
          }),
        output: { purchaseOrderId: ES.String },
        execute: (input) =>
          Effect.gen(function* () {
            const demoOps = yield* DemoOperations
            const purchaseOrderId = yield* demoOps.createPurchaseOrder({
              item: input.item,
              price: input.price,
            })
            yield* Effect.log(`Created purchase order: ${purchaseOrderId}`)
            return { purchaseOrderId }
          }),
      },
    )

    // From generate_po, save to database first, then confirm purchase, and end
    // (Only need to define the edge once - both CFO and else paths converge at generate_po)
    generate_po.next(savePurchaseOrder).next(purchase).end()
  }
}
