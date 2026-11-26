import { Schema as ES } from "effect"
import { describe, expect, test } from "vitest"
import { FormLabel, FormReadOnly, TextBlock, Wrapper } from "@pf/form-schema"
import { listDetailSelection } from "../lib/list-detail-selection"

describe("list detail selection", () => {
  test("keeps read-only fields at the top level", () => {
    const schema = ES.Struct({
      id: ES.String.annotate({ [FormReadOnly]: true }),
      name: ES.String,
    })

    expect(listDetailSelection(schema)).toBe("id\nname")
  })

  test("inlines flatten wrapper children", () => {
    const schema = ES.Struct({
      orderNumber: ES.String,
      deliveryAddress: Wrapper({
        addressLine1: ES.String,
        addressLine2: ES.NullOr(ES.String),
      }).annotate({ [FormLabel]: "Delivery address" }),
    })

    expect(listDetailSelection(schema)).toBe(
      "orderNumber\naddressLine1\naddressLine2",
    )
  })

  test("skips structural-only elements and selects flattened groups", () => {
    const schema = ES.Struct({
      heading: TextBlock("Thank you for your order."),
      items: Wrapper({
        orderLines: ES.Array(ES.String),
      }).annotate({ [FormLabel]: "Items" }),
    })

    expect(listDetailSelection(schema)).toBe("orderLines")
  })
})
