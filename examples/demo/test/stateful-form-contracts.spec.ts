import { DateTime, Effect } from "effect"
import {
  buildFormContractSchema,
  contractFormAt,
  verifyFormContract,
} from "@pf/org-to-graphql-schema/testing"
import { buildFlowContext } from "@pf/process"
import { org } from "../src/org"
import { expect, it } from "bun:test"

it("checks Demo stateful approval and read-only calculator contracts", async () => {
  const schema = await buildFormContractSchema(org)
  const context = buildFlowContext(
    "demo-contract",
    DateTime.unsafeMake("2026-04-01"),
    [],
  )
  const approval = contractFormAt(
    org,
    "/finance/purchase-request/Manager approval",
  )
  for (const [item, value] of [
    ["Laptop", 1500],
    ["Stationery", 12],
  ] as const) {
    const state = { item, value }
    await verifyFormContract({
      schema,
      form: approval,
      fixtures: [
        { name: item, args: [state, context], input: { check: true } },
      ],
    })
    expect(
      await Effect.runPromise(approval.resolveDefaults(state, context)),
    ).toMatchObject({ item, cost: String(value) })
  }
  const calculator = contractFormAt(
    org,
    "/operations/calculator-demo/Show result",
  )
  for (const state of [
    { a: 2, b: 3, result: 5 },
    { a: -2, b: 2, result: 0 },
  ]) {
    await verifyFormContract({
      schema,
      form: calculator,
      fixtures: [
        { name: String(state.result), args: [state, context], input: {} },
      ],
    })
    expect(
      await Effect.runPromise(calculator.resolveDefaults(state, context)),
    ).toEqual({
      firstNumber: String(state.a),
      secondNumber: String(state.b),
      sum: String(state.result),
    })
  }
})
