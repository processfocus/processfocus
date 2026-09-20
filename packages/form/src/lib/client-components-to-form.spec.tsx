import type { ValidationLogicProps } from "@tanstack/react-form"
import { renderToStaticMarkup } from "react-dom/server"
import { parseClientFormDefinition } from "@pf/form-client-representation/client-form-definition"
import { FormComponentType } from "@pf/form-client-representation/types"
import {
  createRuleAwareValidator,
  customValidationLogic,
  dynamicForm,
  getRenderableFieldNames,
  initializeFormValues,
  normalizeSubmitErrors,
  projectFormComponents,
} from "./client-components-to-form"
import { describe, expect, it, mock, spyOn } from "bun:test"

type Validator = Parameters<
  ValidationLogicProps["runValidation"]
>[0]["validators"][number]

it("allows clearing nullable choices but honors explicit required rules", () => {
  const formDefinition = parseClientFormDefinition({
    components: {
      category: {
        _tag: "select",
        field: "category",
        label: "Category",
        options: ["Member", "Guest"],
        emptyValue: "null",
      },
    },
    rules: [],
  })
  const jsonSchema = {
    type: "object",
    properties: { category: { enum: ["Member", "Guest", null] } },
    required: ["category"],
  }
  const validator = createRuleAwareValidator(jsonSchema, formDefinition, {})[
    "~standard"
  ]
  expect(validator.validate({ category: null })).toEqual({
    value: { category: null },
  })
  expect(validator.validate({ category: "Guest" })).toEqual({
    value: { category: "Guest" },
  })
  expect(validator.validate({})).toHaveProperty("issues")
  const required = createRuleAwareValidator(
    jsonSchema,
    {
      ...formDefinition,
      components: {
        category: {
          _tag: FormComponentType.Select,
          field: "category",
          label: "Category",
          options: ["Member", "Guest"],
          emptyValue: "null",
          required: true,
        },
      },
    },
    {},
  )["~standard"]
  expect(required.validate({ category: null })).toHaveProperty("issues")
  const markup = renderToStaticMarkup(
    dynamicForm({
      draftId: "nullable-select",
      formDefinition,
      jsonSchema,
      defaultValues: { category: "Guest" },
      handleSubmit: async () => undefined,
      renderActions: () => null,
    }),
  )
  expect(markup).toContain('<option value="">No selection</option>')
  expect(markup).toContain('<option value="1" selected="">Guest</option>')
})

const syncValidator = () => undefined

it.each([
  { value: "", options: ["Term 1", "Term 2"], selected: "Select an option" },
  {
    value: undefined,
    options: ["Term 1", "Term 2"],
    selected: "Select an option",
  },
  { value: null, options: ["Term 1", "Term 2"], selected: "Select an option" },
  {
    value: "Removed choice",
    options: ["Term 1", "Term 2"],
    selected: "Select an option",
  },
  { value: "Term 1", options: ["Term 1", "Term 2"], selected: "Term 1" },
  { value: "", options: ["", "Term 1"], selected: "No value" },
])(
  "renders the actual select state for $value with $options",
  ({ value, options, selected }) => {
    const markup = renderToStaticMarkup(
      dynamicForm({
        draftId: "select-initial-value",
        jsonSchema: {
          type: "object",
          properties: { term: { enum: options } },
          required: ["term"],
        },
        formDefinition: parseClientFormDefinition({
          components: {
            term: { _tag: "select", field: "term", label: "Term", options },
          },
          rules: [],
        }),
        defaultValues: { term: value },
        handleSubmit: async () => undefined,
        renderActions: () => null,
      }),
    )
    expect(markup).toContain(`selected="">${selected}</option>`)
  },
)

const asyncValidator = () => Promise.resolve(undefined)

describe("initializeFormValues", () => {
  it("merges defaults with saved form values taking precedence", () => {
    expect(
      initializeFormValues(
        { title: "Default title", priority: "normal" },
        { title: "Saved title" },
      ),
    ).toEqual({ title: "Saved title", priority: "normal" })
  })

  it("creates an initial snapshot independent of its inputs", () => {
    const defaultValues = { title: "Default title" }
    const savedValues = { notes: "Saved notes" }
    const initialValues = initializeFormValues(defaultValues, savedValues)

    defaultValues.title = "Changed default"
    savedValues.notes = "Changed notes"

    expect(initialValues).toEqual({
      title: "Default title",
      notes: "Saved notes",
    })
  })
})

const createMockForm = (opts?: {
  submissionAttempts?: number
  fieldMeta?: Record<
    string,
    { errors: unknown[]; isDirty: boolean; isDefaultValue: boolean }
  >
}) => ({
  state: {
    submissionAttempts: opts?.submissionAttempts ?? 0,
    fieldMeta: opts?.fieldMeta ?? {},
  },
  getFieldMeta: (name: string) =>
    opts?.fieldMeta?.[name] ?? {
      errors: [],
      isDirty: false,
      isDefaultValue: true,
    },
})

const createProps = (
  overrides: {
    form?: ReturnType<typeof createMockForm>
    validators?: Record<string, unknown> | null
    // biome-ignore lint/suspicious/noExplicitAny: test helper
    event?: Record<string, any>
    /** Pass true to explicitly set validators to undefined */
    undefinedValidators?: boolean
  } = {},
) => {
  const runValidation = mock(
    (_props: { validators: Validator[]; form: unknown }) => {},
  )
  const resolvedValidators = overrides.undefinedValidators
    ? undefined
    : overrides.validators !== undefined
      ? overrides.validators
      : { onDynamic: syncValidator }
  const props = {
    form: overrides.form ?? createMockForm(),
    validators: resolvedValidators,
    event: {
      type: "change" as const,
      async: false,
      ...overrides.event,
    },
    runValidation,
  } as unknown as ValidationLogicProps & {
    runValidation: typeof runValidation
  }
  return props
}

/** Check whether the real dynamic validator (syncValidator or asyncValidator) was included */
const hasDynamicValidator = (
  runValidation: ReturnType<typeof createProps>["runValidation"],
) => {
  expect(runValidation).toHaveBeenCalled()
  const validators = runValidation.mock.calls[0]?.[0]?.validators as Validator[]
  return validators.some(
    (v) =>
      v !== undefined &&
      "cause" in v &&
      v.cause === "dynamic" &&
      (v.fn === syncValidator || v.fn === asyncValidator),
  )
}

/** Check whether a no-op clearing entry for dynamic errors was included */
const hasDynamicClearingEntry = (
  runValidation: ReturnType<typeof createProps>["runValidation"],
) => {
  expect(runValidation).toHaveBeenCalled()
  const validators = runValidation.mock.calls[0]?.[0]?.validators as Validator[]
  return validators.some(
    (v) =>
      v !== undefined &&
      "cause" in v &&
      v.cause === "dynamic" &&
      v.fn !== syncValidator &&
      v.fn !== asyncValidator,
  )
}

describe("customValidationLogic", () => {
  describe("submit event", () => {
    it("always validates before first submission", () => {
      const props = createProps({
        form: createMockForm({ submissionAttempts: 0 }),
        event: { type: "submit" },
      })
      customValidationLogic(props)
      expect(hasDynamicValidator(props.runValidation)).toBe(true)
    })

    it("always validates after submission", () => {
      const props = createProps({
        form: createMockForm({ submissionAttempts: 1 }),
        event: { type: "submit" },
      })
      customValidationLogic(props)
      expect(hasDynamicValidator(props.runValidation)).toBe(true)
    })

    it("validates regardless of field dirty/default state", () => {
      const props = createProps({
        form: createMockForm({
          submissionAttempts: 0,
          fieldMeta: {
            email: { errors: [], isDirty: false, isDefaultValue: true },
          },
        }),
        event: { type: "submit" },
      })
      customValidationLogic(props)
      expect(hasDynamicValidator(props.runValidation)).toBe(true)
    })
  })

  describe("blur event - before submission", () => {
    it("validates when any field is dirty", () => {
      const props = createProps({
        form: createMockForm({
          submissionAttempts: 0,
          fieldMeta: {
            email: { errors: [], isDirty: true, isDefaultValue: false },
          },
        }),
        event: { type: "blur" },
      })
      customValidationLogic(props)
      expect(hasDynamicValidator(props.runValidation)).toBe(true)
    })

    it("skips validation when no fields are dirty and clears stale errors", () => {
      const props = createProps({
        form: createMockForm({
          submissionAttempts: 0,
          fieldMeta: {
            email: { errors: [], isDirty: false, isDefaultValue: true },
          },
        }),
        event: { type: "blur" },
      })
      customValidationLogic(props)
      expect(hasDynamicValidator(props.runValidation)).toBe(false)
      expect(hasDynamicClearingEntry(props.runValidation)).toBe(true)
    })

    it("skips validation when fieldMeta is empty and clears stale errors", () => {
      const props = createProps({
        form: createMockForm({ submissionAttempts: 0 }),
        event: { type: "blur" },
      })
      customValidationLogic(props)
      expect(props.runValidation).toHaveBeenCalled()
      expect(hasDynamicValidator(props.runValidation)).toBe(false)
      expect(hasDynamicClearingEntry(props.runValidation)).toBe(true)
    })
  })

  describe("blur event - after submission", () => {
    it("always validates regardless of dirty state", () => {
      const props = createProps({
        form: createMockForm({
          submissionAttempts: 1,
          fieldMeta: {
            email: { errors: [], isDirty: false, isDefaultValue: true },
          },
        }),
        event: { type: "blur" },
      })
      customValidationLogic(props)
      expect(hasDynamicValidator(props.runValidation)).toBe(true)
    })
  })

  describe("change event - before submission, no errors", () => {
    it("skips validation when no fields have errors and clears stale errors", () => {
      const props = createProps({
        form: createMockForm({
          submissionAttempts: 0,
          fieldMeta: {
            email: { errors: [], isDirty: true, isDefaultValue: false },
          },
        }),
        event: { type: "change" },
      })
      customValidationLogic(props)
      expect(hasDynamicValidator(props.runValidation)).toBe(false)
      expect(hasDynamicClearingEntry(props.runValidation)).toBe(true)
    })

    it("skips validation when errors exist but field is at default value", () => {
      const props = createProps({
        form: createMockForm({
          submissionAttempts: 0,
          fieldMeta: {
            email: {
              errors: [{ message: "Required" }],
              isDirty: false,
              isDefaultValue: true,
            },
          },
        }),
        event: { type: "change" },
      })
      customValidationLogic(props)
      // Stale errors on a default-value field should not trigger re-validation
      expect(hasDynamicValidator(props.runValidation)).toBe(false)
      expect(hasDynamicClearingEntry(props.runValidation)).toBe(true)
    })
  })

  describe("change event - before submission, field has errors", () => {
    it("validates when any field already has errors", () => {
      const props = createProps({
        form: createMockForm({
          submissionAttempts: 0,
          fieldMeta: {
            email: {
              errors: [{ message: "Required" }],
              isDirty: true,
              isDefaultValue: false,
            },
          },
        }),
        event: { type: "change" },
      })
      customValidationLogic(props)
      expect(hasDynamicValidator(props.runValidation)).toBe(true)
    })
  })

  describe("change event - after submission", () => {
    it("always validates", () => {
      const props = createProps({
        form: createMockForm({
          submissionAttempts: 1,
          fieldMeta: {
            email: { errors: [], isDirty: false, isDefaultValue: true },
          },
        }),
        event: { type: "change" },
      })
      customValidationLogic(props)
      expect(hasDynamicValidator(props.runValidation)).toBe(true)
    })

    it("validates even when no fields have errors", () => {
      const props = createProps({
        form: createMockForm({
          submissionAttempts: 1,
          fieldMeta: {
            name: { errors: [], isDirty: true, isDefaultValue: false },
          },
        }),
        event: { type: "change" },
      })
      customValidationLogic(props)
      expect(hasDynamicValidator(props.runValidation)).toBe(true)
    })
  })

  describe("mount and server events", () => {
    it("does not add dynamic validator for mount events", () => {
      const props = createProps({
        event: { type: "mount" },
      })
      customValidationLogic(props)
      expect(props.runValidation).toHaveBeenCalled()
      expect(hasDynamicValidator(props.runValidation)).toBe(false)
    })

    it("does not add dynamic validator for server events", () => {
      const props = createProps({
        event: { type: "server" },
      })
      customValidationLogic(props)
      expect(props.runValidation).toHaveBeenCalled()
      expect(hasDynamicValidator(props.runValidation)).toBe(false)
    })
  })

  describe("async validation", () => {
    it("uses onDynamicAsync when event.async is true", () => {
      const props = createProps({
        validators: {
          onDynamic: syncValidator,
          onDynamicAsync: asyncValidator,
        },
        event: { type: "submit", async: true },
      })
      customValidationLogic(props)
      const validators = props.runValidation.mock.calls[0]?.[0]
        ?.validators as Validator[]
      const dynamicEntry = validators.find(
        (v) => v !== undefined && "cause" in v && v.cause === "dynamic",
      ) as { fn: unknown; cause: string } | undefined
      expect(dynamicEntry?.fn).toBe(asyncValidator)
    })

    it("uses onDynamic (sync) when event.async is false", () => {
      const props = createProps({
        validators: {
          onDynamic: syncValidator,
          onDynamicAsync: asyncValidator,
        },
        event: { type: "submit", async: false },
      })
      customValidationLogic(props)
      const validators = props.runValidation.mock.calls[0]?.[0]
        ?.validators as Validator[]
      const dynamicEntry = validators.find(
        (v) => v !== undefined && "cause" in v && v.cause === "dynamic",
      ) as { fn: unknown; cause: string } | undefined
      expect(dynamicEntry?.fn).toBe(syncValidator)
    })
  })

  describe("edge cases", () => {
    it("handles null validators", () => {
      const props = createProps({ validators: null })
      customValidationLogic(props)
      expect(props.runValidation).toHaveBeenCalled()
      const validators = props.runValidation.mock.calls[0]?.[0]
        ?.validators as Validator[]
      expect(validators).toEqual([])
    })

    it("handles undefined validators", () => {
      const props = createProps({ undefinedValidators: true })
      customValidationLogic(props)
      expect(props.runValidation).toHaveBeenCalled()
      const validators = props.runValidation.mock.calls[0]?.[0]
        ?.validators as Validator[]
      expect(validators).toEqual([])
    })

    it("handles empty fieldMeta gracefully on blur", () => {
      const form = createMockForm()
      const props = createProps({
        form,
        event: { type: "blur" },
      })
      customValidationLogic(props)
      expect(props.runValidation).toHaveBeenCalled()
      expect(hasDynamicValidator(props.runValidation)).toBe(false)
      expect(hasDynamicClearingEntry(props.runValidation)).toBe(true)
    })
  })
})

describe("form rule projection", () => {
  it("projects components and rules from a structured definition", () => {
    const formDefinition = parseClientFormDefinition({
      components: {
        choice: {
          _tag: "text",
          field: "choice",
          label: "Choice",
          readonly: true,
        },
        details: { _tag: "text", field: "details", label: "Details" },
      },
      rules: [
        {
          condition: {
            _tag: "equals",
            left: { _tag: "field", path: ["choice"] },
            right: { _tag: "literal", value: "disable" },
          },
          effects: [{ target: ["details"], state: { disabled: true } }],
        },
      ],
    })
    const projected = projectFormComponents(formDefinition, {
      choice: "disable",
    })

    expect(projected["choice"]).toMatchObject({
      field: "choice",
      readonly: true,
    })
    expect(projected["details"]).toMatchObject({
      field: "details",
      disabled: true,
    })

    const markup = renderToStaticMarkup(
      dynamicForm({
        draftId: "embedded-form",
        formDefinition,
        defaultValues: { choice: "disable", details: "" },
        handleSubmit: async () => undefined,
        jsonSchema: {
          type: "object",
          properties: {
            choice: { type: "string" },
            details: { type: "string" },
          },
        },
        renderActions: () => null,
        stepPath: "/enrolment/Submit",
        enableProviderUserLookup: false,
      }),
    )

    expect(markup).toContain('name="choice"')
    expect(markup).toContain('name="details"')
    expect(markup).toMatch(
      /<input(?=[^>]*name="details")(?=[^>]*readOnly="")[^>]*>/,
    )
  })

  const schema = {
    type: "object",
    properties: {
      choice: { type: "string" },
      details: { type: "string" },
    },
    required: ["details"],
  }

  const representation = {
    components: {
      choice: {
        _tag: FormComponentType.Text,
        field: "choice",
        label: "Choice",
      },
      details: {
        _tag: FormComponentType.Text,
        field: "details",
        label: "Details",
      },
    },
    rules: [
      {
        condition: {
          _tag: "equals",
          left: { _tag: "field", path: ["choice"] },
          right: { _tag: "literal", value: "hide" },
        },
        effects: [{ target: ["details"], state: { hidden: true } }],
        otherwise: [{ target: ["details"], state: { required: true } }],
      },
    ],
  } as const

  it("recalculates hidden state from base representation and current values", () => {
    const hidden = projectFormComponents(representation, {
      choice: "hide",
    })
    const visible = projectFormComponents(representation, {
      choice: "show",
    })

    expect(hidden["details"]?.hidden).toBe(true)
    expect(visible["details"]?.hidden).toBeUndefined()
    expect(visible["details"]?.required).toBe(true)
  })

  it("projects disabled state from rules", () => {
    const disabledRepresentation = {
      ...representation,
      rules: [
        {
          condition: {
            _tag: "equals",
            left: { _tag: "field", path: ["choice"] },
            right: { _tag: "literal", value: "disable" },
          },
          effects: [{ target: ["details"], state: { disabled: true } }],
        },
      ],
    } as const

    const projected = projectFormComponents(disabledRepresentation, {
      choice: "disable",
    })

    expect(projected["details"]?.disabled).toBe(true)
  })

  it("inherits disabledness from structural targets to child input fields", () => {
    const nestedRepresentation = {
      components: {
        status: {
          _tag: FormComponentType.Text,
          field: "status",
          label: "Status",
        },
        section: {
          _tag: FormComponentType.FieldSet,
          label: "Section",
          children: {
            help: {
              _tag: FormComponentType.Static,
              field: "help",
              label: "Help",
              readonly: true,
            },
            notes: {
              _tag: FormComponentType.Text,
              field: "notes",
              label: "Notes",
            },
          },
        },
      },
      rules: [
        {
          condition: {
            _tag: "equals",
            left: { _tag: "field", path: ["status"] },
            right: { _tag: "literal", value: "disable" },
          },
          effects: [
            { target: ["section"], state: { disabled: true } },
            { target: ["section", "notes"], state: { disabled: false } },
          ],
        },
      ],
    } as const

    const disabled = projectFormComponents(nestedRepresentation, {
      status: "disable",
    })

    expect(disabled["section"]?.disabled).toBe(true)
    if (disabled["section"]?._tag !== FormComponentType.FieldSet) {
      throw new Error("Expected projected section to be a fieldset")
    }
    expect(disabled["section"].children["help"]?.disabled).toBe(true)
    expect(disabled["section"].children["notes"]?.disabled).toBe(true)
  })

  it("validates disabled fields against preserved base values", () => {
    const disabledRepresentation = {
      ...representation,
      rules: [
        {
          condition: {
            _tag: "equals",
            left: { _tag: "field", path: ["choice"] },
            right: { _tag: "literal", value: "disable" },
          },
          effects: [{ target: ["details"], state: { disabled: true } }],
        },
      ],
    } as const
    const validator = createRuleAwareValidator(schema, disabledRepresentation, {
      details: "original value",
    })
    const result = validator["~standard"].validate({
      choice: "disable",
      details: "tampered value",
    })

    expect("issues" in result ? result.issues : undefined).toBeUndefined()
    expect("value" in result ? result.value : undefined).toEqual({
      choice: "disable",
      details: "original value",
    })
  })

  it("rejects disabled required fields without preserved values", () => {
    const disabledRepresentation = {
      ...representation,
      rules: [
        {
          condition: {
            _tag: "equals",
            left: { _tag: "field", path: ["choice"] },
            right: { _tag: "literal", value: "disable" },
          },
          effects: [{ target: ["details"], state: { disabled: true } }],
        },
      ],
    } as const
    const validator = createRuleAwareValidator(
      schema,
      disabledRepresentation,
      {},
    )
    const result = validator["~standard"].validate({
      choice: "disable",
      details: "tampered value",
    })

    expect("issues" in result ? result.issues : []).toContainEqual(
      expect.objectContaining({
        path: ["details"],
        message: "This field is required.",
      }),
    )
  })

  it("does not restore hidden disabled fields from base values", () => {
    const hiddenDisabledRepresentation = {
      ...representation,
      rules: [
        {
          condition: {
            _tag: "equals",
            left: { _tag: "field", path: ["choice"] },
            right: { _tag: "literal", value: "hide" },
          },
          effects: [
            { target: ["details"], state: { hidden: true } },
            { target: ["details"], state: { disabled: true } },
          ],
        },
      ],
    } as const
    const validator = createRuleAwareValidator(
      schema,
      hiddenDisabledRepresentation,
      { details: "original value" },
    )
    const result = validator["~standard"].validate({
      choice: "hide",
      details: "tampered value",
    })

    expect("issues" in result ? result.issues : undefined).toBeUndefined()
    expect("value" in result ? result.value : undefined).toEqual({
      choice: "hide",
    })
  })

  it("suppresses hidden required validation while keeping draft values available", () => {
    const validator = createRuleAwareValidator(schema, representation, {})
    const result = validator["~standard"].validate({
      choice: "hide",
      details: "draft value",
    })

    expect("issues" in result ? result.issues : undefined).toBeUndefined()
    expect("value" in result ? result.value : undefined).toEqual({
      choice: "hide",
    })
  })

  it("shows conditional required errors and rejects whitespace-only strings", () => {
    const validator = createRuleAwareValidator(schema, representation, {})
    const result = validator["~standard"].validate({
      choice: "show",
      details: "   ",
    })

    expect("issues" in result ? result.issues : []).toContainEqual(
      expect.objectContaining({
        path: ["details"],
        message: "This field is required.",
      }),
    )
  })

  it("ignores client-required fields absent from the submission schema", () => {
    const consoleWarn = spyOn(console, "warn").mockImplementation(() => {})
    const validator = createRuleAwareValidator(
      {},
      {
        components: {
          followUpEmailSent: {
            _tag: FormComponentType.Boolean,
            field: "followUpEmailSent",
            label: "I have sent the parents a follow up email.",
            required: true,
          },
        },
        rules: [],
      },
      {},
    )

    try {
      const result = validator["~standard"].validate({
        followUpEmailSent: true,
      })

      expect("issues" in result ? result.issues : undefined).toBeUndefined()
      expect("value" in result ? result.value : undefined).toEqual({})
      expect(consoleWarn).not.toHaveBeenCalled()
    } finally {
      consoleWarn.mockRestore()
    }
  })

  it("ignores nested client-required fields absent from the nested schema", () => {
    const validator = createRuleAwareValidator(
      {
        type: "object",
        properties: {
          parent: {
            type: "object",
            properties: {
              persistedNote: { type: "string" },
            },
          },
        },
      },
      {
        components: {
          parent: {
            _tag: FormComponentType.FieldSet,
            label: "Parent",
            children: {
              followUpEmailSent: {
                _tag: FormComponentType.Boolean,
                field: "parent.followUpEmailSent",
                label: "I have sent the parents a follow up email.",
                required: true,
              },
            },
          },
        },
        rules: [],
      },
      {},
    )

    const result = validator["~standard"].validate({ parent: {} })

    expect("issues" in result ? result.issues : undefined).toBeUndefined()
    expect("value" in result ? result.value : undefined).toEqual({ parent: {} })
  })

  it("follows numeric field segments only through array schemas", () => {
    const itemSchema = {
      type: "object",
      properties: { name: { type: "string" } },
    }
    const indexedRepresentation = {
      components: {
        name: {
          _tag: FormComponentType.Text,
          field: "items[0].name",
          label: "Name",
          required: true,
        },
      },
      rules: [],
    } as const
    const arrayValidator = createRuleAwareValidator(
      {
        type: "object",
        properties: {
          items: { type: "array", items: itemSchema },
        },
      },
      indexedRepresentation,
      {},
    )

    const arrayResult = arrayValidator["~standard"].validate({ items: [{}] })

    expect("issues" in arrayResult ? arrayResult.issues : []).toContainEqual(
      expect.objectContaining({
        path: ["items", 0, "name"],
        message: "This field is required.",
      }),
    )

    const consoleWarn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      const objectValidator = createRuleAwareValidator(
        {
          type: "object",
          properties: {
            items: { type: "object", items: itemSchema },
          },
        },
        indexedRepresentation,
        {},
      )
      const objectResult = objectValidator["~standard"].validate({ items: {} })

      expect(
        "issues" in objectResult ? objectResult.issues : undefined,
      ).toBeUndefined()
    } finally {
      consoleWarn.mockRestore()
    }
  })

  it("suppresses submit errors for hidden fields", () => {
    expect(
      normalizeSubmitErrors(
        [
          {
            field: "details",
            message: "must have required property 'details'",
          },
        ],
        new Set(["choice", "details"]),
        new Set(["details"]),
      ),
    ).toEqual([])
  })

  it("strips hidden nested values from validation input", () => {
    const nestedSchema = {
      type: "object",
      properties: {
        parent: {
          type: "object",
          properties: {
            child: { type: "string" },
            visible: { type: "string" },
          },
        },
      },
    }
    const nestedRepresentation = {
      components: {
        parent: {
          _tag: FormComponentType.FieldSet,
          label: "Parent",
          children: {
            child: {
              _tag: FormComponentType.Text,
              field: "parent.child",
              label: "Child",
            },
            visible: {
              _tag: FormComponentType.Text,
              field: "parent.visible",
              label: "Visible",
            },
          },
        },
      },
      rules: [
        {
          condition: {
            _tag: "present",
            value: { _tag: "literal", value: true },
          },
          effects: [{ target: ["parent", "child"], state: { hidden: true } }],
        },
      ],
    } as const

    const validator = createRuleAwareValidator(
      nestedSchema,
      nestedRepresentation,
      {},
    )
    const result = validator["~standard"].validate({
      parent: { child: "draft value", visible: "shown" },
    })

    expect("value" in result ? result.value : undefined).toEqual({
      parent: { visible: "shown" },
    })
  })

  it("inherits hiddenness from structural targets to child fields", () => {
    const nestedRepresentation = {
      components: {
        status: {
          _tag: FormComponentType.Text,
          field: "status",
          label: "Status",
        },
        section: {
          _tag: FormComponentType.FieldSet,
          label: "Section",
          children: {
            help: {
              _tag: FormComponentType.Static,
              field: "help",
              label: "Help",
              readonly: true,
            },
            notes: {
              _tag: FormComponentType.Text,
              field: "notes",
              label: "Notes",
            },
          },
        },
      },
      rules: [
        {
          condition: {
            _tag: "equals",
            left: { _tag: "field", path: ["status"] },
            right: { _tag: "literal", value: "hide" },
          },
          effects: [
            { target: ["section"], state: { hidden: true } },
            { target: ["section", "notes"], state: { hidden: false } },
          ],
        },
      ],
    } as const

    const hidden = projectFormComponents(nestedRepresentation, {
      status: "hide",
    })

    expect(hidden["section"]?.hidden).toBe(true)
    if (hidden["section"]?._tag !== FormComponentType.FieldSet) {
      throw new Error("Expected projected section to be a fieldset")
    }
    expect(hidden["section"].children["help"]?.hidden).toBe(true)
    expect(hidden["section"].children["notes"]?.hidden).toBe(true)
  })

  it("projects authored paths through list and table item children", () => {
    const nestedRepresentation = {
      components: {
        status: {
          _tag: FormComponentType.Text,
          field: "status",
          label: "Status",
        },
        items: {
          _tag: FormComponentType.List,
          field: "items",
          label: "Items",
          itemChildren: {
            child: {
              _tag: FormComponentType.Text,
              field: "items.child",
              label: "Child",
            },
          },
        },
        rows: {
          _tag: FormComponentType.Table,
          field: "rows",
          label: "Rows",
          itemChildren: {
            summary: {
              _tag: FormComponentType.Static,
              field: "rows.summary",
              label: "Summary",
              readonly: true,
            },
          },
        },
      },
      rules: [
        {
          condition: {
            _tag: "equals",
            left: { _tag: "field", path: ["status"] },
            right: { _tag: "literal", value: "hide" },
          },
          effects: [
            { target: ["items"], state: { hidden: true } },
            { target: ["items", "child"], state: { hidden: false } },
            { target: ["rows"], state: { hidden: true } },
            { target: ["rows", "summary"], state: { hidden: false } },
          ],
        },
      ],
    } as const

    const hidden = projectFormComponents(nestedRepresentation, {
      status: "hide",
    })

    expect(
      hidden["items"]?._tag === FormComponentType.List
        ? hidden["items"].itemChildren["child"]?.hidden
        : undefined,
    ).toBe(true)
    expect(
      hidden["rows"]?._tag === FormComponentType.Table
        ? hidden["rows"].itemChildren["summary"]?.hidden
        : undefined,
    ).toBe(true)
  })

  it("cascades hiddenness through multiple structural levels", () => {
    const nestedRepresentation = {
      components: {
        status: {
          _tag: FormComponentType.Text,
          field: "status",
          label: "Status",
        },
        outer: {
          _tag: FormComponentType.FieldSet,
          label: "Outer",
          children: {
            inner: {
              _tag: FormComponentType.FieldSet,
              label: "Inner",
              children: {
                notes: {
                  _tag: FormComponentType.Text,
                  field: "notes",
                  label: "Notes",
                },
              },
            },
          },
        },
      },
      rules: [
        {
          condition: {
            _tag: "equals",
            left: { _tag: "field", path: ["status"] },
            right: { _tag: "literal", value: "hide" },
          },
          effects: [
            { target: ["outer"], state: { hidden: true } },
            { target: ["outer", "inner", "notes"], state: { hidden: false } },
          ],
        },
      ],
    } as const

    const hidden = projectFormComponents(nestedRepresentation, {
      status: "hide",
    })

    if (hidden["outer"]?._tag !== FormComponentType.FieldSet) {
      throw new Error("Expected projected outer to be a fieldset")
    }
    const inner = hidden["outer"].children["inner"]
    expect(inner?.hidden).toBe(true)
    if (inner?._tag !== FormComponentType.FieldSet) {
      throw new Error("Expected projected inner to be a fieldset")
    }
    expect(inner.children["notes"]?.hidden).toBe(true)
  })

  it("strips child values when a structural target is hidden", () => {
    const flatWrapperSchema = {
      type: "object",
      properties: {
        status: { type: "string" },
        notes: { type: "string" },
      },
      required: ["notes"],
    }
    const nestedRepresentation = {
      components: {
        status: {
          _tag: FormComponentType.Text,
          field: "status",
          label: "Status",
        },
        section: {
          _tag: FormComponentType.FieldSet,
          label: "Section",
          children: {
            notes: {
              _tag: FormComponentType.Text,
              field: "notes",
              label: "Notes",
            },
          },
        },
      },
      rules: [
        {
          condition: {
            _tag: "equals",
            left: { _tag: "field", path: ["status"] },
            right: { _tag: "literal", value: "hide" },
          },
          effects: [{ target: ["section"], state: { hidden: true } }],
        },
      ],
    } as const

    const validator = createRuleAwareValidator(
      flatWrapperSchema,
      nestedRepresentation,
      {},
    )
    const result = validator["~standard"].validate({
      status: "hide",
      notes: "draft value",
    })

    expect("issues" in result ? result.issues : undefined).toBeUndefined()
    expect("value" in result ? result.value : undefined).toEqual({
      status: "hide",
    })
  })

  it("validates required flattened wrapper children by submitted field name", () => {
    const flatWrapperSchema = {
      type: "object",
      properties: {
        status: { type: "string" },
        notes: { type: "string" },
      },
    }
    const nestedRepresentation = {
      components: {
        status: {
          _tag: FormComponentType.Text,
          field: "status",
          label: "Status",
        },
        section: {
          _tag: FormComponentType.FieldSet,
          label: "Section",
          children: {
            notes: {
              _tag: FormComponentType.Text,
              field: "notes",
              label: "Notes",
            },
          },
        },
      },
      rules: [
        {
          condition: {
            _tag: "equals",
            left: { _tag: "field", path: ["status"] },
            right: { _tag: "literal", value: "require" },
          },
          effects: [
            { target: ["section", "notes"], state: { required: true } },
          ],
        },
      ],
    } as const

    const validator = createRuleAwareValidator(
      flatWrapperSchema,
      nestedRepresentation,
      {},
    )

    const populated = validator["~standard"].validate({
      status: "require",
      notes: "draft value",
    })
    const missing = validator["~standard"].validate({ status: "require" })

    expect("issues" in populated ? populated.issues : undefined).toBeUndefined()
    expect("issues" in missing ? missing.issues : []).toContainEqual(
      expect.objectContaining({
        path: ["notes"],
        message: "This field is required.",
      }),
    )
  })

  it("does not emit required errors for populated nested rule targets", () => {
    const nestedSchema = {
      type: "object",
      properties: {
        parent: {
          type: "object",
          properties: {
            child: { type: "string" },
          },
        },
      },
    }
    const nestedRepresentation = {
      components: {
        parent: {
          _tag: FormComponentType.FieldSet,
          label: "Parent",
          children: {
            child: {
              _tag: FormComponentType.Text,
              field: "parent.child",
              label: "Child",
            },
          },
        },
      },
      rules: [
        {
          condition: {
            _tag: "present",
            value: { _tag: "literal", value: true },
          },
          effects: [{ target: ["parent", "child"], state: { required: true } }],
        },
      ],
    } as const

    const validator = createRuleAwareValidator(
      nestedSchema,
      nestedRepresentation,
      {},
    )
    const result = validator["~standard"].validate({
      parent: { child: "filled" },
    })

    expect("issues" in result ? result.issues : undefined).toBeUndefined()
  })

  it("uses path segments for missing nested rule-required fields", () => {
    const nestedSchema = {
      type: "object",
      properties: {
        parent: {
          type: "object",
          properties: {
            child: { type: "string" },
          },
        },
      },
    }
    const nestedRepresentation = {
      components: {
        parent: {
          _tag: FormComponentType.FieldSet,
          label: "Parent",
          children: {
            child: {
              _tag: FormComponentType.Text,
              field: "parent.child",
              label: "Child",
            },
          },
        },
      },
      rules: [
        {
          condition: {
            _tag: "present",
            value: { _tag: "literal", value: true },
          },
          effects: [{ target: ["parent", "child"], state: { required: true } }],
        },
      ],
    } as const

    const validator = createRuleAwareValidator(
      nestedSchema,
      nestedRepresentation,
      {},
    )
    const result = validator["~standard"].validate({ parent: {} })

    expect("issues" in result ? result.issues : []).toContainEqual(
      expect.objectContaining({
        path: ["parent", "child"],
        message: "This field is required.",
      }),
    )
  })

  it("strips hidden list item child values from every item", () => {
    const listSchema = {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              child: { type: "string" },
              visible: { type: "string" },
            },
          },
        },
      },
    }
    const listRepresentation = {
      components: {
        items: {
          _tag: FormComponentType.List,
          field: "items",
          label: "Items",
          itemChildren: {
            child: {
              _tag: FormComponentType.Text,
              field: "items.child",
              label: "Child",
            },
            visible: {
              _tag: FormComponentType.Text,
              field: "items.visible",
              label: "Visible",
            },
          },
        },
      },
      rules: [
        {
          condition: {
            _tag: "present",
            value: { _tag: "literal", value: true },
          },
          effects: [{ target: ["items", "child"], state: { hidden: true } }],
        },
      ],
    } as const

    const validator = createRuleAwareValidator(
      listSchema,
      listRepresentation,
      {},
    )
    const result = validator["~standard"].validate({
      items: [
        { child: "first draft", visible: "first" },
        { child: "second draft", visible: "second" },
      ],
    })

    expect("value" in result ? result.value : undefined).toEqual({
      items: [{ visible: "first" }, { visible: "second" }],
    })
  })

  it("treats empty arrays as missing for rule-required fields", () => {
    const listSchema = {
      type: "object",
      properties: {
        items: { type: "array", items: { type: "object" } },
      },
    }
    const listRepresentation = {
      components: {
        items: {
          _tag: FormComponentType.List,
          field: "items",
          label: "Items",
          itemChildren: {},
        },
      },
      rules: [
        {
          condition: {
            _tag: "present",
            value: { _tag: "literal", value: true },
          },
          effects: [{ target: ["items"], state: { required: true } }],
        },
      ],
    } as const

    const validator = createRuleAwareValidator(
      listSchema,
      listRepresentation,
      {},
    )
    const result = validator["~standard"].validate({ items: [] })

    expect("issues" in result ? result.issues : []).toContainEqual(
      expect.objectContaining({
        path: ["items"],
        message: "This field is required.",
      }),
    )
  })
})

describe("submit error normalization", () => {
  it("collects nested renderable field names but not fieldsets", () => {
    const fieldNames = getRenderableFieldNames({
      contactDetails: {
        _tag: FormComponentType.FieldSet,
        label: "ContactDetails",
        children: {
          firstName: {
            _tag: FormComponentType.Text,
            field: "firstName",
            label: "First name",
          },
          otherInformation: {
            _tag: FormComponentType.TextArea,
            field: "otherInformation",
            label: "Other information",
          },
        },
      },
    })

    expect(fieldNames.has("firstName")).toBe(true)
    expect(fieldNames.has("otherInformation")).toBe(true)
    expect(fieldNames.has("contactDetails")).toBe(false)
  })

  it("converts non-rendered field errors into form-level errors", () => {
    const errors = normalizeSubmitErrors(
      [{ field: "contactDetails", message: "is missing" }],
      new Set(["firstName", "otherInformation"]),
    )

    expect(errors).toEqual([
      { field: "", message: "contactDetails: This field is required." },
    ])
  })

  it("normalizes technical server required messages for rendered fields", () => {
    const errors = normalizeSubmitErrors(
      [
        {
          field: "firstName",
          message: "must have required property 'firstName'",
        },
      ],
      new Set(["firstName"]),
    )

    expect(errors).toEqual([
      { field: "firstName", message: "This field is required." },
    ])
  })

  it("normalizes server email validation messages for rendered fields", () => {
    const errors = normalizeSubmitErrors(
      [{ field: "email", message: "must be a valid email address" }],
      new Set(["email"]),
    )

    expect(errors).toEqual([
      { field: "email", message: "Please enter a valid email address." },
    ])
  })

  it("normalizes server phone validation messages for rendered fields", () => {
    const errors = normalizeSubmitErrors(
      [
        {
          field: "phoneNumber",
          message: "must be a valid phone number (7-15 digits)",
        },
      ],
      new Set(["phoneNumber"]),
    )

    expect(errors).toEqual([
      {
        field: "phoneNumber",
        message: "Please enter a valid phone number.",
      },
    ])
  })
})
