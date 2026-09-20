import { strict as assert } from "node:assert"
import { Schema as ES, Effect, JSONSchema } from "effect"
import {
  FormAutoComplete,
  FormDescription,
  FormLabel,
  FormRadioInput,
  FormReadOnly,
  FormTableInput,
  FormTextAreaInput,
} from "./form-annotations"
import {
  BooleanField,
  Divider,
  Image,
  ListField,
  NumberField,
  NumberFieldFrom,
  RadioField,
  TableField,
  TextArea,
  TextBlock,
  TextField,
  Wrapper,
} from "./form-schema"
import { emitFields, isFieldset, mergedComponentLayer } from "./walker"
import { describe, expect, it } from "bun:test"

describe("Test creating form structure", () => {
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

    const components = emitFields(form.ast).pipe(
      Effect.provide(mergedComponentLayer),
    )
    const form_fields = Effect.runSync(components)
    // console.debug("FORM", form_fields)
    expect(form_fields["username"]).toBe("textfield")
    const agreeField = form_fields["agree"]
    assert(agreeField !== undefined)
    assert(isFieldset(agreeField))
    expect(agreeField.fieldset).toBeDefined()
    const addressField = form_fields["address"]
    assert(addressField !== undefined)
    assert(isFieldset(addressField))
    expect(addressField["fieldset"]["street"]).toBe("textfield")
    expect(addressField["fieldset"]["town"]).toBe("textfield")
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

    const components = emitFields(form.ast).pipe(
      Effect.provide(mergedComponentLayer),
    )
    const form_fields = Effect.runSync(components)

    // Navigate to nested wrapper fields using type guards
    const tabsField = form_fields["tabs"]
    assert(tabsField !== undefined)
    assert(isFieldset(tabsField))

    const tab1Field = tabsField.fieldset["tab1"]
    assert(tab1Field !== undefined)
    assert(isFieldset(tab1Field))
    expect(tab1Field.fieldset["username"]).toBe("textfield")

    expect(form_fields["street"]).toBeUndefined()

    const tab2Field = tabsField.fieldset["tab2"]
    assert(tab2Field !== undefined)
    assert(isFieldset(tab2Field))

    const agreeField = tab2Field.fieldset["agree"]
    assert(agreeField !== undefined)
    assert(isFieldset(agreeField))
    expect(agreeField.fieldset).toBeDefined()

    const addressField = tab1Field.fieldset["address"]
    assert(addressField !== undefined)
    assert(isFieldset(addressField))
    expect(addressField.fieldset["street"]).toBe("textfield")
    expect(addressField.fieldset["town"]).toBe("textfield")
  })

  it("should handle single non-submission elements", () => {
    const form = ES.Struct({
      username: ES.String,
      divider: Divider,
      agree: ES.Struct({
        acceptTerms: ES.Boolean,
      }),
    })

    // Verify form components - divider SHOULD appear in form structure
    const components = emitFields(form.ast).pipe(
      Effect.provide(mergedComponentLayer),
    )
    const form_fields = Effect.runSync(components)
    expect(form_fields["username"]).toBe("textfield")
    expect(form_fields["divider"]).toBe("divider")
    const agreeField = form_fields["agree"]
    assert(agreeField !== undefined)
    assert(isFieldset(agreeField))
    expect(agreeField.fieldset).toBeDefined()
  })

  it("should handle parameterized structural elements", () => {
    const form = ES.Struct({
      title: TextBlock("Welcome to the form"),
      username: ES.String,
      logo: Image("logo.png", "Company Logo"),
      email: ES.String,
    })

    // Verify form components - structural elements SHOULD appear
    const components = emitFields(form.ast).pipe(
      Effect.provide(mergedComponentLayer),
    )
    const form_fields = Effect.runSync(components)
    expect(form_fields["title"]).toBe("textblock")
    expect(form_fields["username"]).toBe("textfield")
    expect(form_fields["logo"]).toBe("image")
    expect(form_fields["email"]).toBe("textfield")
  })
})

describe("Field helper functions", () => {
  it("should create TextField with label and description", () => {
    const field = TextField({
      label: "Street name",
      description: "Your street address",
    })

    const annotations = field.ast.annotations
    expect(annotations[FormLabel]).toBe("Street name")
    expect(annotations[FormDescription]).toBe("Your street address")
  })

  it("should create TextField with autocomplete metadata", () => {
    const field = TextField({
      label: "First name",
      autoComplete: "given-name",
    })

    const annotations = field.ast.annotations
    expect(annotations[FormAutoComplete]).toBe("given-name")
  })

  it("should create TextField with only label", () => {
    const field = TextField({ label: "Username" })

    const annotations = field.ast.annotations
    expect(annotations[FormLabel]).toBe("Username")
    expect(annotations[FormDescription]).toBeUndefined()
  })

  it("should create TextField without options", () => {
    const field = TextField()

    const annotations = field.ast.annotations
    expect(annotations[FormLabel]).toBeUndefined()
    expect(annotations[FormDescription]).toBeUndefined()
  })

  it("should create TextArea with text-area annotation", () => {
    const field = TextArea({ label: "Notes" })

    const annotations = field.ast.annotations
    expect(annotations[FormLabel]).toBe("Notes")
    expect(annotations[FormTextAreaInput]).toBe(true)
  })

  it("should create TableField with table and read-only annotations", () => {
    const field = TableField(
      {
        changedAt: TextField({ label: "Changed At" }),
        action: TextField({ label: "Action" }),
      },
      { label: "History" },
    )

    const annotations = field.ast.annotations
    expect(annotations[FormLabel]).toBe("History")
    expect(annotations[FormTableInput]).toBe(true)
    expect(annotations[FormReadOnly]).toBe(true)
  })

  it("should create NumberField with label and description", () => {
    const field = NumberField({
      label: "Your age",
      description: "Age in years",
    })

    const annotations = field.ast.annotations
    expect(annotations[FormLabel]).toBe("Your age")
    expect(annotations[FormDescription]).toBe("Age in years")
  })

  it("should create BooleanField with label", () => {
    const field = BooleanField({ label: "Accept terms" })

    const annotations = field.ast.annotations
    expect(annotations[FormLabel]).toBe("Accept terms")
  })

  it("should create required BooleanField that rejects false", () => {
    const schema = ES.Struct({
      approved: BooleanField({ label: "I approve", required: true }),
    })

    // true is accepted
    expect(ES.decodeSync(schema)({ approved: true })).toEqual({
      approved: true,
    })

    // false is rejected
    expect(() => ES.decodeSync(schema)({ approved: false })).toThrow()
  })

  it("should produce JSON Schema with enum constraint for required BooleanField", () => {
    const schema = ES.Struct({
      approved: BooleanField({ label: "I approve", required: true }),
    })

    const jsonSchema = JSONSchema.make(schema) as unknown as {
      properties: { approved: { type: string; enum?: boolean[] } }
    }
    expect(jsonSchema.properties.approved.type).toBe("boolean")
    expect(jsonSchema.properties.approved.enum).toEqual([true])
  })

  it("should create NumberFieldFrom with transformation", () => {
    const field = NumberFieldFrom(ES.NumberFromString, { label: "Your age" })

    const annotations = field.ast.annotations
    expect(annotations[FormLabel]).toBe("Your age")
  })

  it("should create RadioField with literal options and preserve literal type", () => {
    const field = RadioField({
      label: "Decision",
      options: [
        { value: "approve", label: "Approve" },
        { value: "reject", label: "Reject" },
      ],
    })
    type FieldType = typeof field.Type
    const selected: FieldType = "approve"

    expect(selected).toBe("approve")
    expect(field.ast.annotations[FormLabel]).toBe("Decision")
    expect(field.ast.annotations[FormRadioInput]).toEqual({
      options: [
        { value: "approve", label: "Approve" },
        { value: "reject", label: "Reject" },
      ],
    })
  })

  it("should require non-optional RadioField and allow optional RadioField", () => {
    const schema = ES.Struct({
      decision: RadioField({
        options: [
          { value: "approve", label: "Approve" },
          { value: "reject", label: "Reject" },
        ],
      }),
      followUp: ES.optional(
        RadioField({
          options: [
            { value: "yes", label: "Yes" },
            { value: "no", label: "No" },
          ],
        }),
      ),
    })

    expect(ES.decodeSync(schema)({ decision: "approve" })).toEqual({
      decision: "approve",
    })
    expect(() => ES.decodeUnknownSync(schema)({})).toThrow()
  })

  it("should work in a struct schema", () => {
    const schema = ES.Struct({
      street: TextField({
        label: "Street name",
        description: "Your street address",
      }),
      age: NumberFieldFrom(ES.NumberFromString, { label: "Your age" }),
      decision: RadioField({
        label: "Decision",
        options: [
          { value: "approve", label: "Approve" },
          { value: "reject", label: "Reject" },
        ],
      }),
      acceptTerms: BooleanField({ label: "Accept terms and conditions" }),
    })

    // Verify the schema is properly structured and the helpers produce valid schemas
    expect(schema.ast._tag).toBe("TypeLiteral")

    // Verify we can decode (proving it's a valid Effect Schema)
    const decoded = ES.decodeSync(schema)({
      street: "123 Main St",
      age: "25",
      decision: "approve",
      acceptTerms: true,
    })
    expect(decoded.street).toBe("123 Main St")
    expect(decoded.age).toBe(25) // NumberFromString converts string to number
    expect(decoded.acceptTerms).toBe(true)
  })

  it("should support chaining with pipe", () => {
    const field = TextField({ label: "Username" }).pipe(
      ES.minLength(3),
      ES.maxLength(20),
    )

    // When using pipe, you get a Refinement schema
    // The important thing is that it's a valid schema that can be used in forms
    expect(field.ast._tag).toBe("Refinement")

    // Verify it can be used in a struct (which is what matters for forms)
    const schema = ES.Struct({ username: field })
    expect(schema.ast._tag).toBe("TypeLiteral")
  })
})

describe("ListField", () => {
  it("should create a list field with item struct", () => {
    const field = ListField({
      first_name: TextField({ label: "First name" }),
      parent_email: TextField({ label: "Parent email" }),
    })

    // Schema.Array without annotations produces a TupleType AST node
    expect(field.ast._tag).toBe("TupleType")
  })

  it("should apply label annotation", () => {
    const field = ListField({ name: ES.String }, { label: "Students" })

    // With annotations, the schema may wrap in a Transformation;
    // the label is accessible on the outer AST node
    expect(field.ast.annotations[FormLabel]).toBe("Students")
  })

  it("should work in a struct schema", () => {
    const schema = ES.Struct({
      students: ListField({
        first_name: TextField({ label: "First name" }),
        parent_email: TextField({ label: "Parent email" }),
      }),
    })

    expect(schema.ast._tag).toBe("TypeLiteral")

    // Verify decoding works
    const decoded = ES.decodeSync(schema)({
      students: [
        { first_name: "Alice", parent_email: "alice@example.com" },
        { first_name: "Bob", parent_email: "bob@example.com" },
      ],
    })
    expect(decoded.students).toHaveLength(2)
    expect(decoded.students[0]?.first_name).toBe("Alice")
  })

  it("should accept empty arrays", () => {
    const schema = ES.Struct({
      items: ListField({ name: ES.String }),
    })

    const decoded = ES.decodeSync(schema)({ items: [] })
    expect(decoded.items).toEqual([])
  })
})
