import { Schema as ES, Effect } from "effect"
import {
  Divider,
  FLATTEN_SYMBOL,
  Image,
  ListField,
  NumberFieldFrom,
  RadioField,
  TextBlock,
  TextField,
  Wrapper,
} from "@pf/form-schema"
import {
  FieldNameCollisionError,
  InvalidFlattenAnnotationError,
  expandSubmissionInput,
  submissionSchema,
  submissionSchemaSync,
} from "./form-submission-schema"
import { describe, expect, it } from "bun:test"

const runSubmissionSchema = <Fields extends ES.Struct.Fields>(
  form: ES.Struct<Fields>,
) => Effect.runSync(submissionSchema(form))

describe("Test flattening form structure", () => {
  it("should flatten wrapper fields into parent struct", () => {
    const form = ES.Struct({
      username: ES.String,
      address: Wrapper({
        street: ES.String,
        town: ES.String,
      }),
      agree: ES.Struct({
        acceptTerms: ES.Boolean,
      }),
    })

    const schema = runSubmissionSchema(form)

    type SchemaType = typeof schema.Type
    const testValue: SchemaType = {
      username: "john",
      street: "Main St",
      town: "Springfield",
      agree: {
        acceptTerms: true,
      },
    }

    // Verify type structure
    expect("username" in testValue).toBe(true)
    expect("street" in testValue).toBe(true)
    expect("town" in testValue).toBe(true)
    expect("agree" in testValue).toBe(true)

    // Verify the schema validates the flat structure
    const result = ES.decodeUnknownSync(schema)(testValue)
    expect(result.username).toBe("john")
    expect(result.street).toBe("Main St")
    expect(result.town).toBe("Springfield")
    expect(result.agree.acceptTerms).toBe(true)
  })

  it("should flatten multiple wrapper fields into parent struct", () => {
    const form = ES.Struct({
      tabs: Wrapper({
        tab1: Wrapper({
          username: ES.String,
          address: Wrapper({
            street: ES.String,
            town: ES.String,
          }),
        }),
        tab2: Wrapper({
          agree: ES.Struct({
            acceptTerms: ES.Boolean,
          }),
        }),
      }),
    })

    const schema = runSubmissionSchema(form)

    type SchemaType = typeof schema.Type
    const testValue: SchemaType = {
      username: "john",
      street: "Main St",
      town: "Springfield",
      agree: {
        acceptTerms: true,
      },
    }

    // Verify type structure
    expect("username" in testValue).toBe(true)
    expect("street" in testValue).toBe(true)
    expect("town" in testValue).toBe(true)
    expect("agree" in testValue).toBe(true)

    // Verify the schema validates the flat structure
    const result = ES.decodeUnknownSync(schema)(testValue)
    expect(result.username).toBe("john")
    expect(result.street).toBe("Main St")
    expect(result.town).toBe("Springfield")
    expect(result.agree.acceptTerms).toBe(true)
  })

  it("should handle single non-submission elements", () => {
    const form = ES.Struct({
      username: ES.String,
      divider: Divider,
      agree: ES.Struct({
        acceptTerms: ES.Boolean,
      }),
    })

    const schema = runSubmissionSchema(form)

    type SchemaType = typeof schema.Type
    const testValue: SchemaType = {
      username: "john",
      agree: {
        acceptTerms: true,
      },
    }

    // Verify type structure - divider should NOT be in submission schema
    expect("username" in testValue).toBe(true)
    expect("divider" in testValue).toBe(false)

    // Verify the schema validates the flat structure
    const result = ES.decodeUnknownSync(schema)(testValue)
    expect(result.username).toBe("john")
    expect(result.agree.acceptTerms).toBe(true)
  })

  it("should handle parameterized structural elements", () => {
    const form = ES.Struct({
      title: TextBlock("Welcome to the form"),
      username: ES.String,
      logo: Image("logo.png", "Company Logo"),
      email: ES.String,
    })

    const schema = runSubmissionSchema(form)

    type SchemaType = typeof schema.Type
    const testValue: SchemaType = {
      username: "john",
      email: "john@example.com",
    }

    // Verify structural elements are NOT in submission schema
    expect("title" in testValue).toBe(false)
    expect("logo" in testValue).toBe(false)
    expect("username" in testValue).toBe(true)
    expect("email" in testValue).toBe(true)

    // Verify the schema validates correctly
    const result = ES.decodeUnknownSync(schema)(testValue)
    expect(result.username).toBe("john")
    expect(result.email).toBe("john@example.com")
  })

  it("should exclude read-only fields from submission schema", () => {
    const form = ES.Struct({
      username: ES.String,
      displayName: TextField({ label: "Display Name", readOnly: true }),
      email: ES.String,
    })

    const schema = runSubmissionSchema(form)

    // Verify read-only field is NOT in schema fields
    expect("username" in schema.fields).toBe(true)
    expect("email" in schema.fields).toBe(true)
    expect("displayName" in schema.fields).toBe(false)

    // Verify the schema validates without the read-only field
    const result = ES.decodeUnknownSync(schema)({
      username: "john",
      email: "john@example.com",
    })
    expect(result.username).toBe("john")
    expect(result.email).toBe("john@example.com")
  })

  it("should exclude read-only fields inside wrappers", () => {
    const form = ES.Struct({
      section: Wrapper({
        editable: ES.String,
        readOnlyField: TextField({ label: "Read Only", readOnly: true }),
      }),
    })

    const schema = runSubmissionSchema(form)

    // Verify only editable field is flattened into schema
    expect("editable" in schema.fields).toBe(true)
    expect("readOnlyField" in schema.fields).toBe(false)

    // Verify the schema validates correctly
    const result = ES.decodeUnknownSync(schema)({ editable: "value" })
    expect(result.editable).toBe("value")
  })

  it("should preserve RadioField in the submission schema", () => {
    const form = ES.Struct({
      decision: RadioField({
        options: [
          { value: "approve", label: "Approve" },
          { value: "reject", label: "Reject" },
        ],
      }),
    })

    const schema = runSubmissionSchema(form)
    type SchemaType = typeof schema.Type
    const testValue: SchemaType = { decision: "approve" }

    expect("decision" in schema.fields).toBe(true)
    expect(ES.decodeUnknownSync(schema)(testValue)).toEqual({
      decision: "approve",
    })
    expect(() => ES.decodeUnknownSync(schema)({ decision: "defer" })).toThrow()
  })
})

describe("submissionSchema error handling", () => {
  it("should fail with FieldNameCollisionError when field names collide", () => {
    const form = ES.Struct({
      street: ES.String,
      address: Wrapper({
        street: ES.String, // Collision!
        town: ES.String,
      }),
    })

    const error = Effect.runSync(Effect.flip(submissionSchema(form)))
    expect(error).toBeInstanceOf(FieldNameCollisionError)
  })

  it("should provide detailed error message for field name collisions", () => {
    const form = ES.Struct({
      email: ES.String,
      contact: Wrapper({
        email: ES.String, // Collision with parent field
        phone: ES.String,
      }),
    })

    const error = Effect.runSync(Effect.flip(submissionSchema(form)))
    expect(error).toBeInstanceOf(FieldNameCollisionError)
    if (error instanceof FieldNameCollisionError) {
      expect(error.fieldName).toBe("email")
      expect(error.wrapperField).toBe("contact...email")
      expect(error.message).toContain("email")
      expect(error.message).toContain("contact...email")
    }
  })

  it("should provide detailed error message for deeply nested field name collisions", () => {
    const form = ES.Struct({
      email: ES.String,
      section: Wrapper({
        contact: Wrapper({
          email: ES.String, // Collision with parent field
        }),
      }),
    })

    const error = Effect.runSync(Effect.flip(submissionSchema(form)))
    expect(error).toBeInstanceOf(FieldNameCollisionError)
    if (error instanceof FieldNameCollisionError) {
      expect(error.fieldName).toBe("email")
      expect(error.wrapperField).toBe("section...email")
      expect(error.message).toContain("email")
      expect(error.message).toContain("section...email")
    }
  })
})

describe("submissionSchemaSync", () => {
  it("returns the flattened schema on success", () => {
    const form = ES.Struct({
      username: ES.String,
      address: Wrapper({
        street: ES.String,
      }),
    })

    const schema = submissionSchemaSync(form)
    expect("username" in schema.fields).toBe(true)
    expect("street" in schema.fields).toBe(true)
    expect("address" in schema.fields).toBe(false)
  })

  it("rethrows a bare FieldNameCollisionError (not FiberFailure)", () => {
    const form = ES.Struct({
      street: ES.String,
      address: Wrapper({
        street: ES.String,
        town: ES.String,
      }),
    })

    try {
      submissionSchemaSync(form)
      throw new Error("Expected FieldNameCollisionError to be thrown")
    } catch (error) {
      expect(error).toBeInstanceOf(FieldNameCollisionError)
      // Effect.runSync wraps Fail as FiberFailure; sync boundary must not.
      expect((error as { readonly _tag?: string })._tag).toBe(
        "FieldNameCollisionError",
      )
      if (error instanceof FieldNameCollisionError) {
        expect(error.fieldName).toBe("street")
        expect(error.wrapperField).toBe("address...street")
      }
    }
  })
})

describe("expandSubmissionInput", () => {
  it("expands successive discriminated union branches inside lists", () => {
    const row = ES.Union(
      ES.Struct({
        kind: ES.Literal("text"),
        text: Wrapper({ content: ES.String }),
      }),
      ES.Struct({
        kind: ES.Literal("count"),
        number: Wrapper({ count: ES.NumberFromString }),
      }),
    )
    const form = ES.Struct({ rows: ES.Array(row) })
    const projection = submissionSchemaSync(form)
    for (const rows of [
      [
        { kind: "text", content: "first" },
        { kind: "count", count: "7" },
      ],
      [
        { kind: "count", count: "12" },
        { kind: "text", content: "second" },
      ],
    ]) {
      const input = { rows }
      expect(ES.is(ES.encodedSchema(projection))(input)).toBe(true)
      expect(expandSubmissionInput(form, input)).toEqual({
        rows: rows.map((value) =>
          value.kind === "text"
            ? { kind: "text", text: { content: value.content } }
            : { kind: "count", number: { count: value.count } },
        ),
      })
    }
  })

  it("expands optional nested/list wrappers and omits display values without decoding inputs", () => {
    const children = {
      details: Wrapper({
        edit: TextField(),
        display: TextField({ readOnly: true }),
        help: TextBlock("Help"),
      }),
      count: ES.optionalWith(NumberFieldFrom(ES.NumberFromString), {
        default: () => 5,
      }).pipe(ES.fromKey("encodedCount")),
    }
    const form = ES.Struct({
      leaf: ES.optional(TextField({ readOnly: true })),
      nested: ES.optional(ES.NullOr(ES.Struct(children))),
      list: ES.optional(ListField(children)),
    })
    const projection = submissionSchemaSync(form)
    expect(expandSubmissionInput(form, {})).toEqual({})
    expect(expandSubmissionInput(form, { nested: null, list: [] })).toEqual({
      nested: null,
      list: [],
    })
    const row = {
      edit: "ok",
      display: "client",
      help: "client",
      encodedCount: "7",
    }
    const input = {
      leaf: "client",
      nested: row,
      list: [row, { edit: "second" }],
    }
    expect(expandSubmissionInput(form, input)).toEqual({
      nested: { details: { edit: "ok" }, encodedCount: "7" },
      list: [
        { details: { edit: "ok" }, encodedCount: "7" },
        { details: { edit: "second" } },
      ],
    })
    const decoded = ES.decodeUnknownSync(projection)(input)
    expect(
      expandSubmissionInput(form, ES.encodeSync(projection)(decoded)),
    ).toEqual({
      nested: { details: { edit: "ok" }, encodedCount: "7" },
      list: [
        { details: { edit: "ok" }, encodedCount: "7" },
        { details: { edit: "second" }, encodedCount: "5" },
      ],
    })
  })

  it("reconstructs wrapper groups from flat submission input", () => {
    const form = ES.Struct({
      contactDetails: Wrapper({
        firstName: ES.String,
        lastName: ES.String,
      }),
      email: ES.String,
    })

    const expanded = expandSubmissionInput(form, {
      firstName: "Alex",
      lastName: "Example",
      email: "alex@example.com",
    })

    expect(expanded).toEqual({
      contactDetails: {
        firstName: "Alex",
        lastName: "Example",
      },
      email: "alex@example.com",
    })
  })

  it("preserves regular nested structs while expanding wrappers", () => {
    const form = ES.Struct({
      contactDetails: Wrapper({
        name: ES.String,
      }),
      address: ES.Struct({
        street: ES.String,
      }),
    })

    const expanded = expandSubmissionInput(form, {
      name: "Alex",
      address: { street: "Main St" },
    })

    expect(expanded).toEqual({
      contactDetails: { name: "Alex" },
      address: { street: "Main St" },
    })
  })

  it("reconstructs deeply nested wrappers from flat submission input", () => {
    const form = ES.Struct({
      section: Wrapper({
        group: Wrapper({
          firstName: ES.String,
          notes: ES.optional(ES.String),
        }),
      }),
    })

    const expanded = expandSubmissionInput(form, {
      firstName: "Alex",
    })

    expect(expanded).toEqual({
      section: {
        group: {
          firstName: "Alex",
        },
      },
    })
  })
})

describe("optional submission containers", () => {
  const children = {
    edit: TextField(),
    display: TextField({ readOnly: true }),
    help: TextBlock("Help"),
    wrapper: Wrapper({ flat: ES.optional(TextField()) }),
  }

  it("removes optional read-only leaves and descendants without requiring containers", () => {
    const schema = submissionSchemaSync(
      ES.Struct({
        leaf: ES.optional(TextField({ readOnly: true })),
        nested: ES.optional(ES.Struct(children)),
        list: ES.optional(ListField(children)),
      }),
    )
    expect(ES.decodeUnknownSync(schema)({})).toEqual({})
    const supplied = {
      edit: "ok",
      display: "client",
      help: "client",
      flat: "flat",
    }
    const decoded = ES.decodeUnknownSync(schema)({
      leaf: "client",
      nested: supplied,
      list: [supplied, supplied],
    })
    expect(decoded).toEqual({
      nested: { edit: "ok", flat: "flat" },
      list: [
        { edit: "ok", flat: "flat" },
        { edit: "ok", flat: "flat" },
      ],
    })
    const typed: typeof schema.Type = {
      nested: { edit: "ok" },
      list: [{ edit: "ok" }],
    }
    expect(typed.nested?.edit).toBe("ok")
    // @ts-expect-error optional read-only leaf is not submitted
    decoded.leaf
    // @ts-expect-error nested read-only fields are not submitted
    decoded.nested?.display
    // @ts-expect-error list structural fields are not submitted
    decoded.list?.[0]?.help
  })

  it("classifies nullable, refined and transformed read-only leaves without classifying their container", () => {
    const display = TextField({ readOnly: true })
    const schema = submissionSchemaSync(
      ES.Struct({
        nullable: ES.NullOr(display),
        refined: ES.optional(display.pipe(ES.minLength(1))),
        transformed: ES.transform(display, ES.Number, {
          strict: true,
          decode: (s) => s.length,
          encode: String,
        }),
        nested: ES.optional(ES.Struct({ edit: TextField(), display })),
      }),
    )
    const result = ES.decodeUnknownSync(schema)({
      nullable: null,
      refined: "client",
      transformed: "client",
      nested: { edit: "ok", display: "client" },
    })
    expect(result).toEqual({ nested: { edit: "ok" } })
    // @ts-expect-error nullable read-only leaves do not enter state
    result.nullable
    // @ts-expect-error transformed read-only leaves do not enter state
    result.transformed
  })

  it("treats read-only union metadata as field-wide without inheriting child metadata onto containers", () => {
    const display = TextField({ readOnly: true })
    const schema = submissionSchemaSync(
      ES.Struct({
        mixed: ES.Union(display, ES.Number),
        container: ES.optional(
          ES.NullOr(ES.Struct({ edit: TextField(), display })),
        ),
      }),
    )
    expect(
      ES.decodeUnknownSync(schema)({
        mixed: 7,
        container: { edit: "ok", display: "client" },
      }),
    ).toEqual({ container: { edit: "ok" } })
    // @ts-expect-error read-only is a field-level classification for the entire union
    const invalid: typeof schema.Type = { mixed: 7 }
    void invalid
  })

  it("retains codecs and filters on transformed nested structs", () => {
    const transformed = ES.transform(
      ES.Struct(children),
      ES.Struct({ ...children, edit: ES.Number }),
      {
        strict: true,
        decode: (value) => ({ ...value, edit: Number(value.edit) }),
        encode: (value) => ({ ...value, edit: String(value.edit) }),
      },
    ).pipe(ES.filter((value) => value.edit > 0))
    const projected = submissionSchemaSync(
      ES.Struct({ nested: ES.optional(transformed) }),
    )
    // Structural fields erase the original schema's service type to unknown;
    // this fixture's synchronous codecs have no service requirements.
    const schema = ES.make<typeof projected.Type, typeof projected.Encoded>(
      projected.ast,
    )
    const decoded = ES.decodeUnknownSync(schema)({
      nested: { edit: "7", display: "client", help: "client" },
    })
    expect(decoded).toEqual({ nested: { edit: 7 } })
    expect(ES.encodeSync(schema)(decoded)).toEqual({ nested: { edit: "7" } })
    expect(() =>
      ES.decodeUnknownSync(schema)({ nested: { edit: "-1" } }),
    ).toThrow()
  })

  it("keeps invalid flatten and collision failures inside optional containers", () => {
    expect(() =>
      submissionSchemaSync(
        ES.Struct({
          nested: ES.optional(
            ES.Struct({
              bad: ES.String.annotations({ [FLATTEN_SYMBOL]: true }),
            }),
          ),
        }),
      ),
    ).toThrow(InvalidFlattenAnnotationError)
    expect(() =>
      submissionSchemaSync(
        ES.Struct({
          nested: ES.optional(
            ES.Struct({
              wrapper: Wrapper({ edit: TextField() }),
              edit: TextField(),
            }),
          ),
        }),
      ),
    ).toThrow(FieldNameCollisionError)
    expect(() =>
      submissionSchemaSync(
        ES.Struct({
          wrapper: Wrapper({ edit: TextField() }),
          edit: TextField(),
        }),
      ),
    ).toThrow(FieldNameCollisionError)
  })

  it("preserves nullability, refinements, cardinality and transformed property codecs", () => {
    const nested = ES.Struct({
      ...children,
      count: ES.optionalWith(NumberFieldFrom(ES.NumberFromString), {
        default: () => 5,
      }).pipe(ES.fromKey("encodedCount")),
      hiddenDefault: ES.optionalWith(TextField({ readOnly: true }), {
        default: () => "server display",
      }),
    })
    const schema = submissionSchemaSync(
      ES.Struct({
        nested: ES.optional(ES.NullOr(nested)),
        list: ES.optional(ListField(children).pipe(ES.minItems(1))),
      }),
    )
    const decode = ES.decodeUnknownSync(schema)
    expect(decode({ nested: null })).toEqual({ nested: null })
    expect(decode({ nested: { edit: "ok" } })).toEqual({
      nested: { edit: "ok", count: 5 },
    })
    const result = decode({
      nested: {
        edit: "ok",
        encodedCount: "7",
        display: "client",
        hiddenDefault: "client",
      },
    })
    expect(result).toEqual({ nested: { edit: "ok", count: 7 } })
    expect(ES.encodeSync(schema)(result)).toEqual({
      nested: { edit: "ok", encodedCount: "7" },
    })
    expect(() => decode({ list: [] })).toThrow()
    expect(() =>
      decode({ nested: { edit: "ok", encodedCount: "invalid" } }),
    ).toThrow()
  })
})
