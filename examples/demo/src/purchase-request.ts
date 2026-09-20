import { Schema as ES, Effect } from "effect"
import { BooleanField, NumberFieldFrom, TextField } from "@pf/form-schema"
import {
  Form,
  NodeStep,
  type OrgUnit,
  Process,
  type Role,
  Sla,
} from "@pf/process"
import { DemoOperations } from "./schema"

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

    // Steps
    const submit_request = new Form(this, "Submit request", {
      name: "Submit purchase request",
      form: () => ({
        item: TextField({ label: "Item" }),
        value: NumberFieldFrom(ES.NumberFromString, { label: "Value" }),
      }),
      role: employeeRole,
      sla: Sla.businessHours(4), // Employee has 4 business hours to submit
    })

    // Start the flow to capture accumulated state
    const flow = this.start(submit_request)

    // new Form with flow scope infers state type automatically
    const manager_approve_request = new Form(flow, "Manager approval", {
      name: "Approve purchase request",
      form: ({ value }) => ({
        item: TextField({
          label: "Item to approve",
          readOnly: true,
          default: value((state) => state.item),
        }),
        cost: TextField({
          label: "Cost",
          readOnly: true,
          default: value((state) => String(state.value)),
        }),
        check: BooleanField({
          label: "I approve",
          required: true,
        }),
      }),
      summary: (state) => ({ What: `${state.item} for ${state.value}` }),
      role: managerRole,
      sla: Sla.businessDays(2), // Manager has 2 business days to approve
    })

    const managerFlow = flow.next(manager_approve_request)

    const cfo_approve_request = new Form(managerFlow, "Procurement approval", {
      name: "Approve expensive purchase request",
      form: () => ({
        check: BooleanField({
          label: "LGTM",
          required: true,
        }),
      }),
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
    // CFO path goes to generate_po
    cfoFlow.next(generate_po)
    // Else path goes directly to generate_po; this FlowPath includes purchaseNumber in state
    const generatePoFlow = managerFlow.elseNext(generate_po)

    // Purchase form for procurement to execute the purchase
    // Scoped to generatePoFlow which has purchaseNumber in state
    const purchase = new Form(generatePoFlow, "Purchase", {
      name: "Execute purchase",
      form: () => ({
        completed: BooleanField({
          label: "I confirm the purchase has been made",
        }),
      }),
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
