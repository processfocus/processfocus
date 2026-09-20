import { Schema as ES } from "effect"
import {
  BooleanField,
  Divider,
  Image,
  Link,
  TextBlock,
  TextField,
  Wrapper,
} from "@pf/form-schema"
import { getSchemaDefaults } from "./schema-defaults"
import { describe, expect, it } from "bun:test"

describe("getSchemaDefaults", () => {
  it("initializes optional and nullable choices with valid empty selections", () => {
    const choices = ES.Literal("Member", "Guest")
    const fields = {
      optional: ES.optional(choices),
      exactOptional: ES.optionalWith(choices, { exact: true }),
      single: ES.optionalWith(ES.Literal("Member"), { exact: true }),
      nullable: ES.NullOr(choices),
      both: ES.optional(ES.NullOr(choices)),
      required: choices,
      nested: ES.Struct({ choice: ES.optionalWith(choices, { exact: true }) }),
      wrapper: Wrapper({ wrapped: ES.NullOr(choices) }),
    }

    const defaults: unknown = getSchemaDefaults(fields)
    expect(defaults).toEqual({
      optional: undefined,
      exactOptional: undefined,
      single: undefined,
      nullable: null,
      both: null,
      required: "",
      nested: { choice: undefined },
      wrapped: null,
    })
  })

  it("should generate default values for string fields", () => {
    const fields = {
      username: ES.String,
      email: ES.String,
    }

    const defaults = getSchemaDefaults(fields)

    expect(defaults).toEqual({
      username: "",
      email: "",
    })
  })

  it("should generate default values for number fields", () => {
    const fields = {
      age: ES.Number,
      score: ES.Number,
    }

    const defaults = getSchemaDefaults(fields)

    expect(defaults).toEqual({
      age: 0,
      score: 0,
    })
  })

  it("should generate default values for NumberFromString fields", () => {
    const fields = {
      age: ES.NumberFromString,
    }

    const defaults = getSchemaDefaults(fields)

    // Typescript sees this as a number, not sure how to fix that, default is ""
    expect(defaults.age as unknown as string).toBe("")
  })

  it("should generate default values for boolean fields", () => {
    const fields = {
      acceptTerms: ES.Boolean,
      newsletter: ES.Boolean,
    }

    const defaults = getSchemaDefaults(fields)

    expect(defaults).toEqual({
      acceptTerms: false,
      newsletter: false,
    })
  })

  it("should generate default values for nested struct fields", () => {
    const fields = {
      username: ES.String,
      address: ES.Struct({
        street: ES.String,
        city: ES.String,
        zipCode: ES.Number,
      }),
    }

    const defaults = getSchemaDefaults(fields)

    expect(defaults).toEqual({
      username: "",
      address: {
        street: "",
        city: "",
        zipCode: 0,
      },
    })
  })

  it("should handle mixed field types", () => {
    const fields = {
      name: ES.String,
      age: ES.Number,
      active: ES.Boolean,
      profile: ES.Struct({
        bio: ES.String,
        verified: ES.Boolean,
      }),
    }

    const defaults = getSchemaDefaults(fields)

    expect(defaults).toEqual({
      name: "",
      age: 0,
      active: false,
      profile: {
        bio: "",
        verified: false,
      },
    })
  })

  it("should flatten wrapper field defaults into the parent object", () => {
    const fields = {
      username: ES.String,
      contactDetails: Wrapper({
        firstName: ES.String,
        childHasSpecialLearningNeeds: BooleanField({
          label: "My child has special learning needs",
          default: false,
        }),
      }),
    }

    const defaults = getSchemaDefaults(fields)

    expect(defaults as Record<string, unknown>).toEqual({
      username: "",
      firstName: "",
      childHasSpecialLearningNeeds: false,
    })
    expect(
      (defaults as Record<string, unknown>)["contactDetails"],
    ).toBeUndefined()
  })

  it("should flatten nested wrapper field defaults recursively", () => {
    const fields = {
      sections: Wrapper({
        contactDetails: Wrapper({
          firstName: ES.String,
          subscribed: ES.Boolean,
        }),
      }),
    }

    const defaults = getSchemaDefaults(fields)

    expect(defaults as Record<string, unknown>).toEqual({
      firstName: "",
      subscribed: false,
    })
  })

  it("should handle refinements by using the underlying type", () => {
    const fields = {
      email: ES.String.pipe(ES.minLength(5)),
      age: ES.Number.pipe(ES.positive()),
    }

    const defaults = getSchemaDefaults(fields)

    expect(defaults).toEqual({
      email: "",
      age: 0,
    })
  })

  it("should generate empty array default for array/list fields", () => {
    const fields = {
      name: ES.String,
      students: ES.Array(
        ES.Struct({
          first_name: ES.String,
          parent_email: ES.String,
        }),
      ),
    }

    const defaults = getSchemaDefaults(fields)

    expect(defaults).toEqual({
      name: "",
      students: [],
    })
  })

  it("should exclude structural-only fields (TextBlock, Divider, etc.) from defaults", () => {
    const fields = {
      introduction: TextBlock("Welcome to the form"),
      name: ES.String,
      divider: Divider,
      image: Image("/logo.png", "Logo"),
      link: Link("/terms", "Terms and Conditions"),
      email: ES.String,
    }

    const defaults = getSchemaDefaults(fields)

    // Structural-only fields should be excluded from defaults
    // Type system still includes them (as undefined), but runtime excludes them
    expect(defaults.name).toBe("")
    expect(defaults.email).toBe("")
    expect(
      (defaults as Record<string, unknown>)["introduction"],
    ).toBeUndefined()
    expect((defaults as Record<string, unknown>)["divider"]).toBeUndefined()
    expect((defaults as Record<string, unknown>)["image"]).toBeUndefined()
    expect((defaults as Record<string, unknown>)["link"]).toBeUndefined()
  })

  it("should exclude read-only fields from defaults", () => {
    const fields = {
      name: ES.String,
      displayName: TextField({
        label: "Display name",
        readOnly: true,
      }),
    }

    const defaults = getSchemaDefaults(fields)

    expect(defaults as Record<string, unknown>).toEqual({ name: "" })
    expect((defaults as Record<string, unknown>)["displayName"]).toBeUndefined()
  })
})
