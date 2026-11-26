import { Schema } from "effect"
import { toFormJsonSchema } from "./json-schema"
import { expect, it } from "bun:test"

it("retains authored numeric bounds and metadata in the form JSON contract", () => {
  const schema = Schema.Struct({
    amount: Schema.Number.check(Schema.isGreaterThan(0)).annotate({
      title: "Amount",
      description: "A positive amount",
    }),
    nested: Schema.Struct({
      scores: Schema.Array(
        Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
      ),
    }),
  })

  expect(toFormJsonSchema(schema)).toMatchObject({
    properties: {
      amount: {
        type: "number",
        exclusiveMinimum: 0,
        title: "Amount",
        description: "A positive amount",
      },
      nested: {
        properties: {
          scores: {
            type: "array",
            items: { type: "number", minimum: 1, maximum: 5 },
          },
        },
      },
    },
  })
})
