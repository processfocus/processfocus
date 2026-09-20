import { Option, Schema } from "effect"
import { FormPermission } from "@pf/form-schema"
import {
  getSchemaAnnotationDeep,
  toSerializableGraphQLExtensions,
} from "../src/lib/resolver-utils"
import { describe, expect, it } from "bun:test"

describe("toSerializableGraphQLExtensions", () => {
  it("replaces circular references with a stable sentinel", () => {
    const circular: { name: string; self?: unknown } = { name: "root" }
    circular.self = circular

    const result = toSerializableGraphQLExtensions({ circular })

    expect(result).toEqual({
      circular: {
        name: "root",
        self: "[Circular]",
      },
    })
  })
})

describe("getSchemaAnnotationDeep", () => {
  const permission = { modify: "/Business Manager" }

  it("finds annotations directly on a schema AST", () => {
    const schema = Schema.String.annotations({ [FormPermission]: permission })

    const result = getSchemaAnnotationDeep(schema, FormPermission)

    expect(Option.getOrUndefined(result)).toEqual(permission)
  })

  it("finds annotations wrapped by optional", () => {
    const schema = Schema.Struct({
      field: Schema.optional(
        Schema.String.annotations({ [FormPermission]: permission }),
      ),
    })

    const result = getSchemaAnnotationDeep(schema, FormPermission)

    expect(Option.getOrUndefined(result)).toEqual(permission)
  })

  it("finds permission annotations on optional transformed property signatures", () => {
    const fromInput = Schema.optionalWith(
      Schema.NumberFromString.annotations({ [FormPermission]: permission }),
      { default: () => 5 },
    )
    const fromSignature = Schema.optionalWith(Schema.NumberFromString, {
      default: () => 5,
    }).annotations({ [FormPermission]: permission })
    for (const field of [fromInput, fromSignature])
      expect(
        Option.getOrUndefined(getSchemaAnnotationDeep(field, FormPermission)),
      ).toEqual(permission)
  })

  it("finds annotations on union branches", () => {
    const schema = Schema.Union(
      Schema.String.annotations({ [FormPermission]: permission }),
      Schema.Number,
    )

    const result = getSchemaAnnotationDeep(schema, FormPermission)

    expect(Option.getOrUndefined(result)).toEqual(permission)
  })

  it("finds permissions on the output side of property transformations", () => {
    const field = Schema.optionalToRequired(
      Schema.String,
      Schema.String.annotations({ [FormPermission]: permission }),
      {
        decode: Option.getOrElse(() => "default"),
        encode: Option.some,
      },
    )

    expect(
      Option.getOrUndefined(getSchemaAnnotationDeep(field, FormPermission)),
    ).toEqual(permission)
  })

  it("returns none when the annotation is absent", () => {
    const result = getSchemaAnnotationDeep(Schema.String, FormPermission)

    expect(Option.isNone(result)).toBe(true)
  })
})
