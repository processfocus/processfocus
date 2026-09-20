import { Cause, Schema as ES, Effect, Exit, Option } from "effect"
import {
  BooleanField,
  CalendarSlotField,
  CurrentProviderUser,
  FileField,
  FormDescription,
  FormLabel,
  FormPermission,
  Link,
  LinkButton,
  ListField,
  LookupField,
  MetricBreakdown,
  NumberField,
  NumberFieldFrom,
  ProviderUserField,
  RadioField,
  StructuralOnly,
  SuggestionField,
  TableField,
  TextArea,
  TextBlock,
  TextField,
  Wrapper,
} from "@pf/form-schema"
import { asClientRepresentation } from "./as-client-representation"
import { registerWalkerPlugin, unregisterWalkerPlugin } from "./plugin-registry"
import { FormComponentType, type NumberField as NumberFieldType } from "./types"
import { describe, expect, it } from "bun:test"

const managementRole = { node: { path: "/management" } }
const TestPluginAnnotation = Symbol.for("test/permission-plugin")

const runFailure = <const Fields extends ES.Struct.Fields>(
  schema: ES.Struct<Fields>,
) => {
  const exit = Effect.runSyncExit(asClientRepresentation(schema))
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isSuccess(exit)) {
    throw new Error("Expected client representation to fail")
  }

  return Option.getOrThrow(Cause.failureOption(exit.cause))
}

describe("asClientRepresentation", () => {
  it("should convert simple fields to form components", () => {
    const schema = ES.Struct({
      username: ES.String,
      age: ES.Number,
      isActive: ES.Boolean,
    })

    const result = Effect.runSync(asClientRepresentation(schema))

    expect(result).toEqual({
      username: {
        field: "username",
        _tag: FormComponentType.Text,
        label: "Username",
      },
      age: {
        field: "age",
        _tag: FormComponentType.Number,
        label: "Age",
      },
      isActive: {
        field: "isActive",
        _tag: FormComponentType.Boolean,
        label: "Is active",
      },
    })
  })

  it("uses schema titles before humanized field-name fallbacks", () => {
    const schema = ES.Struct({
      firstName: ES.String.annotations({ title: "First name" }),
      childName: ES.String,
      middleName: ES.NullOr(ES.String),
    })

    const result = Effect.runSync(asClientRepresentation(schema))

    expect(result.firstName.label).toBe("First name")
    expect(result.childName.label).toBe("Child name")
    expect(result.middleName.label).toBe("Middle name")
  })

  it("should handle nested regular FieldSet with parent in path", () => {
    const schema = ES.Struct({
      username: ES.String,
      address: ES.Struct({
        street: ES.String,
        city: ES.String,
      }),
    })

    const result = Effect.runSync(asClientRepresentation(schema))

    expect(result.username).toEqual({
      field: "username",
      _tag: FormComponentType.Text,
      label: "Username",
    })

    const addressField = result.address
    expect(addressField._tag).toBe(FormComponentType.FieldSet)
    expect(addressField.label).toBe("Address")

    expect(addressField.children).toEqual({
      street: {
        field: "address.street",
        _tag: FormComponentType.Text,
        label: "Street",
      },
      city: {
        field: "address.city",
        _tag: FormComponentType.Text,
        label: "City",
      },
    })
  })

  it("should handle flattened/wrapped FieldSet without parent in path", () => {
    const schema = ES.Struct({
      username: ES.String,
      address: Wrapper({
        street: ES.String,
        city: ES.String,
      }),
    })

    const result = Effect.runSync(asClientRepresentation(schema))

    expect(result.username).toEqual({
      field: "username",
      _tag: FormComponentType.Text,
      label: "Username",
    })

    const addressField = result.address
    expect(addressField._tag).toBe(FormComponentType.FieldSet)
    expect(addressField.label).toBe("Address")

    expect(addressField.children).toEqual({
      street: {
        field: "street", // No "address." prefix
        _tag: FormComponentType.Text,
        label: "Street",
      },
      city: {
        field: "city", // No "address." prefix
        _tag: FormComponentType.Text,
        label: "City",
      },
    })
  })

  it("should extract FormLabel and FormDescription annotations", () => {
    const schema = ES.Struct({
      username: ES.String.annotations({
        [FormLabel]: "User Name",
        [FormDescription]: "Your unique username",
      }),
      age: ES.Number.annotations({
        [FormLabel]: "Age (years)",
      }),
    })

    const result = Effect.runSync(asClientRepresentation(schema))

    expect(result.username).toEqual({
      field: "username",
      _tag: FormComponentType.Text,
      label: "User Name",
      description: "Your unique username",
    })

    expect(result.age).toEqual({
      field: "age",
      _tag: FormComponentType.Number,
      label: "Age (years)",
    })
  })

  it("should represent text areas separately from text fields", () => {
    const schema = ES.Struct({
      notes: TextArea({ label: "Notes" }),
    })

    const result = Effect.runSync(asClientRepresentation(schema))

    expect(result.notes.field).toBe("notes")
    expect((result.notes as { _tag: FormComponentType })._tag).toBe(
      FormComponentType.TextArea,
    )
    expect(result.notes.label).toBe("Notes")
  })

  it("should handle transformations by using input side", () => {
    const schema = ES.Struct({
      age: ES.NumberFromString,
    })

    const result = Effect.runSync(asClientRepresentation(schema))

    // NumberFromString transforms string -> number
    // Client representation should show TextField (input is string)
    expect(result.age).toEqual({
      field: "age",
      _tag: FormComponentType.Text,
      label: "Age",
    })
  })

  it("should handle refinements by unwrapping to base type", () => {
    const schema = ES.Struct({
      username: ES.String.pipe(ES.minLength(3), ES.maxLength(20)),
    })

    const result = Effect.runSync(asClientRepresentation(schema))

    // Refinements unwrap to base type (String)
    expect(result.username).toEqual({
      field: "username",
      _tag: FormComponentType.Text,
      label: "Username",
    })
  })

  it("should handle nested flattened FieldSets", () => {
    const schema = ES.Struct({
      personal: Wrapper({
        name: ES.String,
        contact: Wrapper({
          email: ES.String,
          phone: ES.String,
        }),
      }),
    })

    const result = Effect.runSync(asClientRepresentation(schema))

    const personalField = result.personal
    expect(personalField._tag).toBe(FormComponentType.FieldSet)
    expect("field" in personalField).toBe(false)

    expect(personalField.children.name.field).toBe("name")

    const contactField = personalField.children.contact
    expect(contactField._tag).toBe(FormComponentType.FieldSet)
    expect("field" in contactField).toBe(false)

    expect(contactField.children.email.field).toBe("email")
    expect(contactField.children.phone.field).toBe("phone")
  })

  it("should handle mixed regular and flattened FieldSets", () => {
    const schema = ES.Struct({
      user: ES.Struct({
        name: ES.String,
        address: Wrapper({
          street: ES.String,
          city: ES.String,
        }),
      }),
    })

    const result = Effect.runSync(asClientRepresentation(schema))

    const userField = result.user
    expect(userField._tag).toBe(FormComponentType.FieldSet)

    // Regular field under regular FieldSet
    expect(userField.children.name.field).toBe("user.name")

    // Flattened FieldSet under regular FieldSet
    const addressField = userField.children.address
    expect(addressField._tag).toBe(FormComponentType.FieldSet)
    expect("field" in addressField).toBe(false)

    // Children of flattened FieldSet don't include "address" but do include "user"
    expect(addressField.children.street.field).toBe("user.street")
    expect(addressField.children.city.field).toBe("user.city")
  })

  it("should handle annotations on transformations", () => {
    const schema = ES.Struct({
      age: ES.NumberFromString.annotations({
        [FormLabel]: "Your Age",
        [FormDescription]: "Enter your age in years",
      }),
    })

    const result = Effect.runSync(asClientRepresentation(schema))

    expect(result.age).toEqual({
      field: "age",
      _tag: FormComponentType.Text,
      label: "Your Age",
      description: "Enter your age in years",
    })
  })

  it("should allow Wrapper() as top-level schema", () => {
    // Wrapper could be tabs or multi-step form.
    const wrapperSchema = Wrapper({
      username: ES.String,
      age: ES.Number,
    })

    const result = Effect.runSync(asClientRepresentation(wrapperSchema))

    expect(result).toEqual({
      username: {
        field: "username",
        _tag: FormComponentType.Text,
        label: "Username",
      },
      age: {
        field: "age",
        _tag: FormComponentType.Number,
        label: "Age",
      },
    })
  })

  it("should work with field helper functions", () => {
    const schema = ES.Struct({
      street: TextField({
        label: "Street name",
        description: "Your street address",
      }),
      age: NumberFieldFrom(ES.NumberFromString, {
        label: "Your age",
        description: "Age in years",
      }),
      acceptTerms: BooleanField({ label: "Accept terms and conditions" }),
    })

    const result = Effect.runSync(asClientRepresentation(schema))

    expect(result.street).toEqual({
      field: "street",
      _tag: FormComponentType.Text,
      label: "Street name",
      description: "Your street address",
    })

    // Runtime type is Number, but compile-time type inference sees Text (based on schema's I type)
    // We cast to check the actual runtime value which uses FormNumberInput annotation
    expect(result.age as unknown as NumberFieldType).toEqual({
      field: "age",
      _tag: FormComponentType.Number,
      label: "Your age",
      description: "Age in years",
    })

    expect(result.acceptTerms).toEqual({
      field: "acceptTerms",
      _tag: FormComponentType.Boolean,
      label: "Accept terms and conditions",
    })
  })

  it("should represent radio fields with option labels and values", () => {
    const schema = ES.Struct({
      decision: RadioField({
        label: "Decision",
        description: "Choose one.",
        options: [
          { value: "approve", label: "Approve" },
          { value: "reject", label: "Reject" },
        ],
      }),
    })

    const result = Effect.runSync(asClientRepresentation(schema))

    expect(result.decision).toEqual({
      field: "decision",
      _tag: FormComponentType.Radio,
      label: "Decision",
      description: "Choose one.",
      options: [
        { value: "approve", label: "Approve" },
        { value: "reject", label: "Reject" },
      ],
    })
  })

  it("should carry autocomplete metadata for text fields", () => {
    const schema = ES.Struct({
      firstName: TextField({
        label: "First name",
        autoComplete: "given-name",
      }),
    })

    const result = Effect.runSync(asClientRepresentation(schema))

    expect(result.firstName).toEqual({
      field: "firstName",
      _tag: FormComponentType.Text,
      label: "First name",
      autoComplete: "given-name",
    })
  })

  it("should work with field helpers in nested structures", () => {
    const schema = ES.Struct({
      username: TextField({ label: "Username" }),
      address: ES.Struct({
        street: TextField({ label: "Street", description: "Street address" }),
        zipCode: NumberField({ label: "ZIP Code" }),
      }),
    })

    const result = Effect.runSync(asClientRepresentation(schema))

    expect(result.username).toEqual({
      field: "username",
      _tag: FormComponentType.Text,
      label: "Username",
    })

    const addressField = result.address
    expect(addressField._tag).toBe(FormComponentType.FieldSet)
    expect(addressField.label).toBe("Address")

    expect(addressField.children.street).toEqual({
      field: "address.street",
      _tag: FormComponentType.Text,
      label: "Street",
      description: "Street address",
    })

    expect(addressField.children.zipCode).toEqual({
      field: "address.zipCode",
      _tag: FormComponentType.Number,
      label: "ZIP Code",
    })
  })

  it("should handle ListField producing a List component with itemChildren", () => {
    const schema = ES.Struct({
      students: ListField(
        {
          first_name: TextField({ label: "First name" }),
          parent_email: TextField({ label: "Parent email" }),
        },
        { label: "Students", addButtonLabel: "Another student" },
      ),
    })

    const result = Effect.runSync(asClientRepresentation(schema))

    expect(result.students._tag).toBe(FormComponentType.List)
    expect(result.students.label).toBe("Students")
    expect(result.students.field).toBe("students")
    if (result.students._tag !== FormComponentType.List) {
      throw new Error("Expected students to be a list field")
    }
    expect(result.students.addButtonLabel).toBe("Another student")

    expect(result.students.itemChildren).toEqual({
      first_name: {
        field: "students.first_name",
        _tag: FormComponentType.Text,
        label: "First name",
      },
      parent_email: {
        field: "students.parent_email",
        _tag: FormComponentType.Text,
        label: "Parent email",
      },
    })
  })

  it("should handle ListField with plain Schema types", () => {
    const schema = ES.Struct({
      tags: ListField(
        { name: ES.String, priority: ES.Number },
        { label: "Tags" },
      ),
    })

    const result = Effect.runSync(asClientRepresentation(schema))

    expect(result.tags._tag).toBe(FormComponentType.List)
    expect(result.tags.label).toBe("Tags")

    expect(result.tags.itemChildren).toEqual({
      name: {
        field: "tags.name",
        _tag: FormComponentType.Text,
        label: "Name",
      },
      priority: {
        field: "tags.priority",
        _tag: FormComponentType.Number,
        label: "Priority",
      },
    })
  })

  it("should handle TableField producing a Table component with itemChildren", () => {
    const schema = ES.Struct({
      history: TableField(
        {
          changedAt: TextField({ label: "Changed At" }),
          action: TextField({ label: "Action" }),
        },
        { label: "History" },
      ),
    })

    const result = Effect.runSync(asClientRepresentation(schema))

    expect(result.history._tag).toBe(FormComponentType.Table)
    expect(result.history.label).toBe("History")
    expect(result.history.readonly).toBe(true)
    expect(result.history.field).toBe("history")
    expect(result.history.itemChildren).toEqual({
      changedAt: {
        field: "history.changedAt",
        _tag: FormComponentType.Text,
        label: "Changed At",
      },
      action: {
        field: "history.action",
        _tag: FormComponentType.Text,
        label: "Action",
      },
    })
  })

  it("should handle TextBlock structural elements", () => {
    const schema = ES.Struct({
      introduction: TextBlock("Welcome to the form"),
      username: ES.String,
    })

    const result = Effect.runSync(asClientRepresentation(schema))

    expect(result.introduction).toEqual({
      field: "introduction",
      _tag: FormComponentType.Static,
      label: "Introduction",
      readonly: true,
      content: "Welcome to the form",
    })
    expect(result.username._tag).toBe(FormComponentType.Text)
  })

  it("should handle Link structural elements", () => {
    const schema = ES.Struct({
      composeEmail: Link(
        "https://mail.google.com/mail/?view=cm&fs=1&to=parent@example.com",
        "Open Gmail draft",
      ),
      username: ES.String,
    })

    const result = Effect.runSync(asClientRepresentation(schema))

    expect(result.composeEmail).toEqual({
      field: "composeEmail",
      _tag: FormComponentType.Link,
      label: "Compose email",
      readonly: true,
      url: "https://mail.google.com/mail/?view=cm&fs=1&to=parent@example.com",
      text: "Open Gmail draft",
    })
    expect(result.username._tag).toBe(FormComponentType.Text)
  })

  it("should handle LinkButton structural elements", () => {
    const schema = ES.Struct({
      composeEmail: LinkButton(
        "https://mail.google.com/mail/?view=cm&fs=1&to=parent@example.com",
        "Open Gmail draft",
      ),
      username: ES.String,
    })

    const result = Effect.runSync(asClientRepresentation(schema))

    expect(result.composeEmail).toEqual({
      field: "composeEmail",
      _tag: FormComponentType.Link,
      readonly: true,
      url: "https://mail.google.com/mail/?view=cm&fs=1&to=parent@example.com",
      text: "Open Gmail draft",
      display: "button",
    })
    expect(result.username._tag).toBe(FormComponentType.Text)
  })

  it("should preserve LinkButton color options", () => {
    const schema = ES.Struct({
      composeEmail: LinkButton(
        "https://mail.google.com/mail/?view=cm&fs=1&to=parent@example.com",
        "Open Gmail draft",
        { color: "blue" },
      ),
    })

    const result = Effect.runSync(asClientRepresentation(schema))

    expect(result.composeEmail).toMatchObject({
      _tag: FormComponentType.Link,
      display: "button",
      color: "blue",
    })
  })

  it("should handle metric breakdown structural elements", () => {
    const schema = ES.Struct({
      costs: MetricBreakdown({
        title: "Usage costs",
        badge: "Prototype",
        currency: "USD",
        dataSource: "item",
        rendererPluginData: { usageCostsSubject: "project" },
        contextFields: ["projectNumber", "environmentName"],
        fields: [{ label: "Period", value: "Last 30 days" }],
        controls: [
          {
            type: "selector",
            name: "usageCostsPeriod",
            urlParameter: "period",
            label: "Period (UTC)",
            value: "last-30-days",
            options: [
              { label: "Last 30 days", value: "last-30-days" },
              { label: "Current month", value: "current-month" },
            ],
          },
        ],
        buckets: [
          {
            label: "CodeBuild",
            amount: 18.42,
            color: "sky",
            description: "Build costs",
          },
        ],
      }),
    })

    const result = Effect.runSync(asClientRepresentation(schema))

    expect(result.costs).toEqual({
      field: "costs",
      _tag: FormComponentType.MetricBreakdown,
      label: "Costs",
      readonly: true,
      title: "Usage costs",
      badge: "Prototype",
      currency: "USD",
      dataSource: "item",
      rendererPluginData: { usageCostsSubject: "project" },
      contextFields: ["projectNumber", "environmentName"],
      fields: [{ label: "Period", value: "Last 30 days" }],
      controls: [
        {
          type: "selector",
          name: "usageCostsPeriod",
          urlParameter: "period",
          label: "Period (UTC)",
          value: "last-30-days",
          options: [
            { label: "Last 30 days", value: "last-30-days" },
            { label: "Current month", value: "current-month" },
          ],
        },
      ],
      buckets: [
        {
          label: "CodeBuild",
          amount: 18.42,
          color: "sky",
          description: "Build costs",
        },
      ],
    })
  })

  it("should carry modify permission metadata on supported fields", () => {
    const schema = ES.Struct({
      requestedFor: ProviderUserField({
        label: "Requested for",
        default: CurrentProviderUser,
        permission: { modify: managementRole },
      }),
    })

    const result = Effect.runSync(asClientRepresentation(schema))

    expect(result.requestedFor as unknown).toEqual({
      field: "requestedFor",
      _tag: FormComponentType.ProviderUser,
      label: "Requested for",
      permission: { modify: "/management" },
    })
  })

  it("should preserve fields without permission metadata", () => {
    const schema = ES.Struct({
      username: TextField({ label: "Username" }),
    })

    const result = Effect.runSync(asClientRepresentation(schema))

    expect(result.username).toEqual({
      field: "username",
      _tag: FormComponentType.Text,
      label: "Username",
    })
  })

  it("should allow optional restricted fields without defaults", () => {
    const schema = ES.Struct({
      delegate: ES.optional(
        TextField({ permission: { modify: managementRole } }),
      ),
    })

    const result = Effect.runSync(asClientRepresentation(schema))

    expect(result.delegate).toMatchObject({
      field: "delegate",
      _tag: FormComponentType.Text,
      permission: { modify: "/management" },
    })
  })

  it("should carry modify permission metadata on textarea fields", () => {
    const schema = ES.Struct({
      notes: TextArea({
        default: "hello",
        permission: { modify: managementRole },
      }),
    })

    const result = Effect.runSync(asClientRepresentation(schema))

    expect(result.notes).toMatchObject({
      field: "notes",
      _tag: FormComponentType.TextArea,
      permission: { modify: "/management" },
    })
  })

  it("should carry modify permission metadata on lookup fields", () => {
    const schema = ES.Struct({
      region: LookupField({
        default: "region-1",
        permission: { modify: managementRole },
      }),
    })

    const result = Effect.runSync(asClientRepresentation(schema))

    expect(result.region).toMatchObject({
      field: "region",
      _tag: FormComponentType.Lookup,
      permission: { modify: "/management" },
    })
  })

  it("should mark suggestion fields as free-text lookups", () => {
    const schema = ES.Struct({
      recipient: SuggestionField({
        default: "external@example.com",
        permission: { modify: managementRole },
      }),
    })

    const result = Effect.runSync(asClientRepresentation(schema))

    expect(result.recipient).toMatchObject({
      field: "recipient",
      _tag: FormComponentType.Lookup,
      permission: { modify: "/management" },
      allowFreeText: true,
    })
  })

  it("should convert calendar slot fields with display metadata", () => {
    const schema = ES.Struct({
      appointment: CalendarSlotField({
        label: "Appointment time",
        timeZone: "Pacific/Auckland",
        locale: "en-NZ",
        calendar: {
          weekStartsOn: 0,
          businessDays: [1, 2, 3, 4, 5],
        },
        emptyMessageHtml: "No times.",
        loadErrorMessageHtml: "Could not load times.",
      }),
    })

    const result = Effect.runSync(asClientRepresentation(schema))

    expect(result.appointment as unknown).toEqual({
      field: "appointment",
      _tag: FormComponentType.CalendarSlot,
      label: "Appointment time",
      timeZone: "Pacific/Auckland",
      locale: "en-NZ",
      calendar: {
        weekStartsOn: 0,
        businessDays: [1, 2, 3, 4, 5],
      },
      emptyMessageHtml: "No times.",
      loadErrorMessageHtml: "Could not load times.",
    })
  })

  it("should carry modify permission metadata on number, boolean, and file fields", () => {
    const schema = ES.Struct({
      count: NumberField({
        default: 1,
        permission: { modify: managementRole },
      }),
      approved: BooleanField({
        default: false,
        permission: { modify: managementRole },
      }),
      attachment: FileField({
        documentStore: { node: { path: "/documents" } },
        default: "file-1",
        permission: { modify: managementRole },
      }),
    })

    const result = Effect.runSync(asClientRepresentation(schema))

    expect(result.count).toMatchObject({
      _tag: FormComponentType.Number,
      permission: { modify: "/management" },
    })
    expect(result.approved).toMatchObject({
      _tag: FormComponentType.Boolean,
      permission: { modify: "/management" },
    })
    expect(result.attachment).toMatchObject({
      _tag: FormComponentType.File,
      permission: { modify: "/management" },
    })
  })

  it("should reject restricted required fields without defaults", () => {
    const schema = ES.Struct({
      requestedFor: TextField({ permission: { modify: managementRole } }),
    })

    expect(runFailure(schema)).toMatchObject({
      _tag: "InvalidFieldPermissionError",
      fieldName: "requestedFor",
    })
  })

  it("should reject permissions on nested fields", () => {
    const schema = ES.Struct({
      details: ES.Struct({
        requestedFor: TextField({
          default: "user-1",
          permission: { modify: managementRole },
        }),
      }),
    })

    expect(runFailure(schema)).toMatchObject({
      _tag: "InvalidFieldPermissionError",
      fieldName: "requestedFor",
    })
  })

  it("should reject permissions on wrappers and structural-only fields", () => {
    const wrapperSchema = ES.Struct({
      details: Wrapper({
        requestedFor: TextField({ default: "user-1" }),
      }).annotations({ [FormPermission]: { modify: managementRole } }),
    })
    const structuralSchema = ES.Struct({
      info: StructuralOnly.annotations({
        [FormPermission]: { modify: managementRole },
      }),
    })

    expect(runFailure(wrapperSchema)).toMatchObject({
      _tag: "InvalidFieldPermissionError",
      fieldName: "details",
    })
    expect(runFailure(structuralSchema)).toMatchObject({
      _tag: "InvalidFieldPermissionError",
      fieldName: "info",
    })
  })

  it("should reject permissions on list fields", () => {
    const schema = ES.Struct({
      items: ListField(
        { name: TextField({ default: "item" }) },
        { default: [], permission: { modify: managementRole } },
      ),
    })

    expect(runFailure(schema)).toMatchObject({
      _tag: "InvalidFieldPermissionError",
      fieldName: "items",
    })
  })

  it("should reject permissions on read-only fields", () => {
    const schema = ES.Struct({
      requestedFor: TextField({
        default: "user-1",
        readOnly: true,
        permission: { modify: managementRole },
      }),
    })

    expect(runFailure(schema)).toMatchObject({
      _tag: "InvalidFieldPermissionError",
      fieldName: "requestedFor",
    })
  })

  it("should reject permissions on plugin fields", () => {
    registerWalkerPlugin({
      type: "permission-test-plugin",
      matchAnnotation: (annotations) =>
        annotations[TestPluginAnnotation] === true,
    })
    const schema = ES.Struct({
      plugin: ES.String.annotations({
        [TestPluginAnnotation]: true,
        [FormPermission]: { modify: managementRole },
      }),
    })

    try {
      expect(runFailure(schema)).toMatchObject({
        _tag: "InvalidFieldPermissionError",
        fieldName: "plugin",
      })
    } finally {
      unregisterWalkerPlugin("permission-test-plugin")
    }
  })
})

describe("Fixed string choice dropdowns", () => {
  it("projects literal choices, including a single choice and nullable choices", async () => {
    const components = await Effect.runPromise(
      asClientRepresentation(
        ES.Struct({
          category: ES.Literal("Member", "Guest").annotations({
            title: "Category",
          }),
          only: ES.Literal("Member"),
          optional: ES.NullOr(ES.Literal("Member", "Guest")),
          omitted: ES.optional(ES.Literal("Member", "Guest")),
          nullableSingle: ES.NullOr(ES.Literal("Member")),
        }),
      ),
    )
    expect(components["category"]).toMatchObject({
      _tag: FormComponentType.Select,
      field: "category",
      label: "Category",
      options: ["Member", "Guest"],
    })
    const tag: FormComponentType.Select = components.category._tag
    expect(tag).toBe(FormComponentType.Select)
    expect(components.category.options).toEqual(["Member", "Guest"])
    expect(components["only"]).toMatchObject({
      _tag: FormComponentType.Select,
      options: ["Member"],
    })
    expect(components["optional"]).toMatchObject({
      _tag: FormComponentType.Select,
      options: ["Member", "Guest"],
      emptyValue: "null",
    })
    expect(components["omitted"]).toMatchObject({ emptyValue: "undefined" })
    expect(components["nullableSingle"]).toMatchObject({ emptyValue: "null" })
  })
})
