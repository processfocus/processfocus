import type { ReactElement } from "react"
import type { FormComponent } from "@pf/form-client-representation/types"
import { FormComponentType } from "@pf/form-client-representation/types"
import { FieldDescription } from "@pf/shadcn-components"
import { walkClientRepresentation } from "./walker"
import { describe, expect, it } from "bun:test"

// Create a mock form - AppField is used as JSX component
// In JSX, it becomes a React element with type=MockAppField
const createMockForm = () => ({
  AppField: function MockAppField(_props: {
    name: string
    children: () => unknown
  }) {
    return null // JSX doesn't execute this, it creates an element with this as type
  },
})

// Helper to extract props from React elements
const getProps = (element: unknown): Record<string, unknown> => {
  if (element && typeof element === "object" && "props" in element) {
    return (element as ReactElement).props as Record<string, unknown>
  }
  return {}
}

// Helper to get the type name of a React element
const getTypeName = (element: unknown): string => {
  if (element && typeof element === "object" && "type" in element) {
    const type = (element as ReactElement).type
    if (typeof type === "function") {
      return type.name
    }
    if (typeof type === "string") {
      return type
    }
  }
  return "unknown"
}

// Helper to render the children function and get the child element
const renderChildren = (element: unknown): unknown => {
  const props = getProps(element)
  const children = props["children"] as (() => unknown) | undefined
  if (typeof children === "function") {
    return children()
  }
  return undefined
}

describe("walkClientRepresentation", () => {
  describe("FieldDescription", () => {
    it("renders trusted HTML only through the explicit prop", () => {
      const element = FieldDescription({
        trustedHtml: '<a href="/terms">Terms</a>',
      })

      expect(getProps(element)["dangerouslySetInnerHTML"]).toEqual({
        __html: '<a href="/terms">Terms</a>',
      })
      expect(getProps(element)["children"]).toBeUndefined()
    })

    it("renders string children as escaped React text", () => {
      const element = FieldDescription({
        children: '<a href="/terms">Terms</a>',
      })

      expect(getProps(element)["children"]).toBe('<a href="/terms">Terms</a>')
      expect(getProps(element)["dangerouslySetInnerHTML"]).toBeUndefined()
    })
  })

  describe("Text field", () => {
    it("renders every component in the component map", () => {
      const form = createMockForm()
      const components: Record<string, FormComponent> = {
        name: {
          _tag: FormComponentType.Text,
          field: "name",
          label: "Name",
        },
        notes: {
          _tag: FormComponentType.TextArea,
          field: "notes",
          label: "Notes",
        },
      }

      const elements = walkClientRepresentation(form, components)

      expect(elements).toHaveLength(2)
      expect(getTypeName(elements[0])).toBe("MockAppField")
      expect(getProps(elements[0])["name"]).toBe("name")
      expect(getProps(elements[1])["name"]).toBe("notes")
    })

    it("does not render hidden fields", () => {
      const form = createMockForm()
      const components: Record<string, FormComponent> = {
        name: {
          _tag: FormComponentType.Text,
          field: "name",
          label: "Name",
          hidden: true,
        },
      }

      const elements = walkClientRepresentation(form, components)

      expect(elements).toHaveLength(0)
    })

    it("renders disabled fields as read-only controls", () => {
      const form = createMockForm()
      const components: Record<string, FormComponent> = {
        name: {
          _tag: FormComponentType.Text,
          field: "name",
          label: "Name",
          disabled: true,
        },
      }

      const elements = walkClientRepresentation(form, components, true)
      const child = renderChildren(elements[0])

      expect(getProps(child)["autoFocus"]).toBe(false)
      expect(getProps(child)["readOnly"]).toBe(true)
    })

    it("creates AppField with correct name prop", () => {
      const form = createMockForm()
      const components: Record<string, FormComponent> = {
        name: {
          _tag: FormComponentType.Text,
          field: "userName",
          label: "Full Name",
          description: "Enter your full name",
        },
      }

      const elements = walkClientRepresentation(form, components)

      expect(elements).toHaveLength(1)
      expect(getTypeName(elements[0])).toBe("MockAppField")
      expect(getProps(elements[0])["name"]).toBe("userName")
    })

    it("renders TextField child with label and description", () => {
      const form = createMockForm()
      const components: Record<string, FormComponent> = {
        name: {
          _tag: FormComponentType.Text,
          field: "name",
          label: "Full Name",
          description: "Enter your full name",
        },
      }

      const elements = walkClientRepresentation(form, components)
      const child = renderChildren(elements[0])

      expect(getTypeName(child)).toBe("TextField")
      expect(getProps(child)["label"]).toBe("Full Name")
      expect(getProps(child)["descriptionHtml"]).toBe("Enter your full name")
    })

    it("passes autocomplete metadata to TextField", () => {
      const form = createMockForm()
      const components: Record<string, FormComponent> = {
        firstName: {
          _tag: FormComponentType.Text,
          field: "firstName",
          label: "First name",
          autoComplete: "given-name",
        },
      }

      const elements = walkClientRepresentation(form, components)
      const child = renderChildren(elements[0])

      expect(getProps(child)["autoComplete"]).toBe("given-name")
    })

    it("renders TextAreaField child for textarea components", () => {
      const form = createMockForm()
      const components: Record<string, FormComponent> = {
        notes: {
          _tag: FormComponentType.TextArea,
          field: "notes",
          label: "Notes",
        },
      }

      const elements = walkClientRepresentation(form, components)
      const child = renderChildren(elements[0])

      expect(getTypeName(child)).toBe("TextAreaField")
      expect(getProps(child)["label"]).toBe("Notes")
    })

    it("sets autoFocus on first field when isFirstField=true", () => {
      const form = createMockForm()
      const components: Record<string, FormComponent> = {
        name: {
          _tag: FormComponentType.Text,
          field: "name",
          label: "Name",
        },
      }

      const elements = walkClientRepresentation(form, components, true)
      const child = renderChildren(elements[0])

      expect(getProps(child)["autoFocus"]).toBe(true)
    })

    it("does not set autoFocus when readonly", () => {
      const form = createMockForm()
      const components: Record<string, FormComponent> = {
        name: {
          _tag: FormComponentType.Text,
          field: "name",
          label: "Name",
          readonly: true,
        },
      }

      const elements = walkClientRepresentation(form, components, true)
      const child = renderChildren(elements[0])

      expect(getProps(child)["autoFocus"]).toBe(false)
      expect(getProps(child)["readOnly"]).toBe(true)
    })

    it("skips readonly fields and autofocuses first editable field", () => {
      const form = createMockForm()
      const components: Record<string, FormComponent> = {
        readonlyField: {
          _tag: FormComponentType.Text,
          field: "readonly",
          label: "Readonly",
          readonly: true,
        },
        editableField: {
          _tag: FormComponentType.Text,
          field: "editable",
          label: "Editable",
        },
      }

      const elements = walkClientRepresentation(form, components, true)

      const firstChild = renderChildren(elements[0])
      const secondChild = renderChildren(elements[1])

      expect(getProps(firstChild)["autoFocus"]).toBe(false)
      expect(getProps(secondChild)["autoFocus"]).toBe(true)
    })

    it("does not set autoFocus when isFirstField=false", () => {
      const form = createMockForm()
      const components: Record<string, FormComponent> = {
        name: {
          _tag: FormComponentType.Text,
          field: "name",
          label: "Name",
        },
      }

      const elements = walkClientRepresentation(form, components, false)
      const child = renderChildren(elements[0])

      expect(getProps(child)["autoFocus"]).toBe(false)
    })
  })

  describe("Number field", () => {
    it("renders TextField with inputMode=decimal", () => {
      const form = createMockForm()
      const components: Record<string, FormComponent> = {
        age: {
          _tag: FormComponentType.Number,
          field: "age",
          label: "Age",
          description: "Your age",
        },
      }

      const elements = walkClientRepresentation(form, components)
      const child = renderChildren(elements[0])

      expect(getTypeName(child)).toBe("TextField")
      expect(getProps(child)["inputMode"]).toBe("decimal")
      expect(getProps(child)["label"]).toBe("Age")
    })

    it("handles readonly number fields", () => {
      const form = createMockForm()
      const components: Record<string, FormComponent> = {
        age: {
          _tag: FormComponentType.Number,
          field: "age",
          label: "Age",
          readonly: true,
        },
      }

      const elements = walkClientRepresentation(form, components, true)
      const child = renderChildren(elements[0])

      expect(getProps(child)["autoFocus"]).toBe(false)
      expect(getProps(child)["readOnly"]).toBe(true)
    })
  })

  describe("Boolean field", () => {
    it("renders BooleanField component", () => {
      const form = createMockForm()
      const components: Record<string, FormComponent> = {
        agree: {
          _tag: FormComponentType.Boolean,
          field: "agree",
          label: "I agree",
        },
      }

      const elements = walkClientRepresentation(form, components)
      const child = renderChildren(elements[0])

      expect(getTypeName(child)).toBe("BooleanField")
      expect(getProps(child)["label"]).toBe("I agree")
    })

    it("passes readonly to boolean field", () => {
      const form = createMockForm()
      const components: Record<string, FormComponent> = {
        agree: {
          _tag: FormComponentType.Boolean,
          field: "agree",
          label: "I agree",
          readonly: true,
        },
      }

      const elements = walkClientRepresentation(form, components)
      const child = renderChildren(elements[0])

      expect(getProps(child)["readOnly"]).toBe(true)
    })

    it("does not pass native required to boolean fields", () => {
      const form = createMockForm()
      const components: Record<string, FormComponent> = {
        hasSpecialLearningNeeds: {
          _tag: FormComponentType.Boolean,
          field: "hasSpecialLearningNeeds",
          label: "Has special learning needs",
          required: true,
        },
      }

      const elements = walkClientRepresentation(form, components)
      const child = renderChildren(elements[0])

      expect(getProps(child)["required"]).toBeUndefined()
    })

    it("passes description to boolean field", () => {
      const form = createMockForm()
      const components: Record<string, FormComponent> = {
        agree: {
          _tag: FormComponentType.Boolean,
          field: "agree",
          label: "I agree",
          description: "Please tick if applicable.",
        },
      }

      const elements = walkClientRepresentation(form, components)
      const child = renderChildren(elements[0])

      expect(getProps(child)["descriptionHtml"]).toBe(
        "Please tick if applicable.",
      )
    })
  })

  it("renders fixed choices as a dropdown with read-only and focus metadata", () => {
    const elements = walkClientRepresentation(createMockForm(), {
      category: {
        _tag: FormComponentType.Select,
        field: "category",
        label: "Category",
        options: ["Member", "Guest"],
        emptyValue: "null",
        readonly: true,
      },
    })
    const child = renderChildren(elements[0])
    expect(getTypeName(child)).toBe("SelectField")
    expect(getProps(child)["options"]).toEqual(["Member", "Guest"])
    expect(getProps(child)["readOnly"]).toBe(true)
    expect(getProps(child)["emptyValue"]).toBe("null")
  })

  describe("Radio field", () => {
    it("renders RadioField component with options", () => {
      const form = createMockForm()
      const components: Record<string, FormComponent> = {
        decision: {
          _tag: FormComponentType.Radio,
          field: "decision",
          label: "Decision",
          description: "Choose one.",
          options: [
            { value: "approve", label: "Approve" },
            { value: "reject", label: "Reject" },
          ],
        },
      }

      const elements = walkClientRepresentation(form, components)
      const child = renderChildren(elements[0])

      expect(getTypeName(child)).toBe("RadioField")
      expect(getProps(child)["label"]).toBe("Decision")
      expect(getProps(child)["descriptionHtml"]).toBe("Choose one.")
      expect(getProps(child)["options"]).toEqual([
        { value: "approve", label: "Approve" },
        { value: "reject", label: "Reject" },
      ])
    })
  })

  describe("FieldSet", () => {
    it("renders FieldSetField with label", () => {
      const form = createMockForm()
      const components: Record<string, FormComponent> = {
        address: {
          _tag: FormComponentType.FieldSet,
          label: "Address",
          children: {
            street: {
              _tag: FormComponentType.Text,
              field: "address.street",
              label: "Street",
            },
          },
        },
      }

      const elements = walkClientRepresentation(form, components)

      expect(elements).toHaveLength(1)
      expect(getTypeName(elements[0])).toBe("FieldSetField")
      expect(getProps(elements[0])["label"]).toBe("Address")
    })

    it("renders nested children as array", () => {
      const form = createMockForm()
      const components: Record<string, FormComponent> = {
        address: {
          _tag: FormComponentType.FieldSet,
          label: "Address",
          children: {
            street: {
              _tag: FormComponentType.Text,
              field: "address.street",
              label: "Street",
            },
            city: {
              _tag: FormComponentType.Text,
              field: "address.city",
              label: "City",
            },
          },
        },
      }

      const elements = walkClientRepresentation(form, components)
      const fieldsetProps = getProps(elements[0])
      const children = fieldsetProps["children"] as unknown[]

      expect(children).toHaveLength(2)
      expect(getProps(children[0])["name"]).toBe("address.street")
      expect(getProps(children[1])["name"]).toBe("address.city")
    })

    it("does not autoFocus nested fields (isFirstField=false for children)", () => {
      const form = createMockForm()
      const components: Record<string, FormComponent> = {
        address: {
          _tag: FormComponentType.FieldSet,
          label: "Address",
          children: {
            street: {
              _tag: FormComponentType.Text,
              field: "address.street",
              label: "Street",
            },
          },
        },
      }

      const elements = walkClientRepresentation(form, components, true)
      const fieldsetProps = getProps(elements[0])
      const children = fieldsetProps["children"] as unknown[]
      const nestedChild = renderChildren(children[0])

      // Nested fields should NOT have autoFocus
      expect(getProps(nestedChild)["autoFocus"]).toBe(false)
    })
  })

  describe("MetricBreakdown", () => {
    it("delegates metric breakdown rendering to a plugin", () => {
      const form = createMockForm()
      const components: Record<string, FormComponent> = {
        costs: {
          _tag: FormComponentType.MetricBreakdown,
          field: "costs",
          label: "Costs",
          title: "Usage costs",
          currency: "USD",
          rendererPluginType: "missing-plugin",
          buckets: [{ label: "CodeBuild", amount: 18.42, color: "sky" }],
        },
      }

      const elements = walkClientRepresentation(form, components)

      expect(elements).toHaveLength(1)
      expect(getTypeName(elements[0])).toBe("MetricBreakdownPluginRenderer")
      expect(getProps(elements[0])["component"]).toBe(components["costs"])
    })
  })

  describe("Multiple fields", () => {
    it("only autoFocuses the first field", () => {
      const form = createMockForm()
      const components: Record<string, FormComponent> = {
        first: {
          _tag: FormComponentType.Text,
          field: "first",
          label: "First",
        },
        second: {
          _tag: FormComponentType.Text,
          field: "second",
          label: "Second",
        },
      }

      const elements = walkClientRepresentation(form, components, true)

      expect(elements).toHaveLength(2)

      const firstChild = renderChildren(elements[0])
      const secondChild = renderChildren(elements[1])

      expect(getProps(firstChild)["autoFocus"]).toBe(true)
      expect(getProps(secondChild)["autoFocus"]).toBe(false)
    })

    it("returns correct number of elements for mixed types", () => {
      const form = createMockForm()
      const components: Record<string, FormComponent> = {
        a: { _tag: FormComponentType.Text, field: "a", label: "A" },
        b: { _tag: FormComponentType.Number, field: "b", label: "B" },
        c: { _tag: FormComponentType.Boolean, field: "c", label: "C" },
      }

      const elements = walkClientRepresentation(form, components)

      expect(elements).toHaveLength(3)
    })
  })

  describe("Plugin fields", () => {
    it("passes the form step and to-do context to the renderer wrapper", () => {
      const form = createMockForm()
      const components: Record<string, FormComponent> = {
        document: {
          _tag: FormComponentType.Plugin,
          field: "document",
          label: "Document",
          pluginType: "example-plugin",
        },
      }

      const [element] = walkClientRepresentation(
        form,
        components,
        true,
        "/process/Select document",
        true,
        { todoId: "todo-1" },
      )

      expect(getProps(element)).toMatchObject({
        stepPath: "/process/Select document",
        todoId: "todo-1",
      })
    })
  })

  describe("Field name mapping", () => {
    it("uses component.field for AppField name (not the object key)", () => {
      const form = createMockForm()
      const components: Record<string, FormComponent> = {
        myKey: {
          _tag: FormComponentType.Text,
          field: "nested.path.field",
          label: "Field",
        },
      }

      const elements = walkClientRepresentation(form, components)

      // The AppField should use the field path, not the key
      expect(getProps(elements[0])["name"]).toBe("nested.path.field")
    })
  })
})
