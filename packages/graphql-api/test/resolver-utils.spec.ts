import { Effect as MigratedEffect, Option, Schema } from "effect"
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
    const schema = Schema.String.annotate({ [FormPermission]: permission })

    const result = getSchemaAnnotationDeep(schema, FormPermission)

    expect(Option.getOrUndefined(result)).toEqual(permission)
  })

  it("finds annotations wrapped by optional", () => {
    const schema = Schema.Struct({
      field: Schema.optional(
        Schema.String.annotate({ [FormPermission]: permission }),
      ),
    })

    const result = getSchemaAnnotationDeep(schema, FormPermission)

    expect(Option.getOrUndefined(result)).toEqual(permission)
  })

  it("finds permission annotations on optional transformed property signatures", () => {
    const fromInput = Schema.NumberFromString.annotate({
      [FormPermission]: permission,
    }).pipe(Schema.withDecodingDefaultType(MigratedEffect.sync(() => 5)))
    const fromSignature = Schema.NumberFromString.pipe(
      Schema.withDecodingDefaultType(MigratedEffect.sync(() => 5)),
    ).annotate({ [FormPermission]: permission })
    for (const field of [fromInput, fromSignature])
      expect(
        Option.getOrUndefined(getSchemaAnnotationDeep(field, FormPermission)),
      ).toEqual(permission)
  })

  it("finds annotations on union branches", () => {
    const schema = Schema.Union([
      Schema.String.annotate({ [FormPermission]: permission }),
      Schema.Number,
    ])

    const result = getSchemaAnnotationDeep(schema, FormPermission)

    expect(Option.getOrUndefined(result)).toEqual(permission)
  })

  it("finds permissions on the output side of property transformations", () => {
    const field = Schema.String.annotate({ [FormPermission]: permission }).pipe(
      Schema.withDecodingDefaultKey(MigratedEffect.succeed("default")),
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
