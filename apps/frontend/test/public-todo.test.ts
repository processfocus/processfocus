import { JSDOM } from "jsdom"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test, vi } from "vitest"
import { parseClientFormDefinition } from "@pf/form-client-representation/client-form-definition"
import { FormComponentType } from "@pf/form-client-representation/types"
import { isPublicPath } from "../lib/auth/config"
import { isPublicTodoLinkError } from "../lib/public-todo-graphql-errors"
import {
  parsePublicTodoFormDefinition,
  publicTodoDefaultValues,
  publicTodoStateCopy,
  publicTodoTerminalStatusFromResult,
  publicTodoUnsupportedComponentTypes,
} from "../lib/public-todo-model"

const completePublicTodo = vi.fn()
const fetchPublicTodo = vi.fn()
const dynamicForm = vi.fn(() => "Submit")
const publicTodoCalendarSlots = vi.fn()
const publicTodoLookupSuggestions = vi.fn()
const requestFreshPublicTodoLink = vi.fn()
const notFound = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND")
})

const publicTodoGraphqlError = (code: string) => ({
  response: {
    errors: [
      {
        extensions: { code },
      },
    ],
  },
})

vi.mock("@/lib/public-todo-form-runtime", () => ({
  dynamicForm,
  LookupProvider: ({ children }: { readonly children: unknown }) => children,
}))

vi.mock("next/navigation", () => ({
  notFound,
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock("../lib/public-todo-server", () => {
  class PublicTodoConfigurationError extends Error {
    constructor() {
      super("FRONTEND_JWT_TOKEN is not configured.")
    }
  }

  return {
    PublicTodoConfigurationError,
    completePublicTodo,
    fetchPublicTodo,
    requestFreshPublicTodoLink,
    publicTodoCalendarSlots,
    publicTodoLookupSuggestions,
    isPublicTodoLinkError,
    publicTodoFieldErrorsFromGraphqlError: (error: unknown) =>
      error instanceof Error && error.message === "validation"
        ? [{ field: "name", message: "Name is required" }]
        : null,
  }
})

describe("public todo routes", () => {
  test("treats public todo page and api routes as public", () => {
    expect(isPublicPath("/public/form/token-123")).toBe(true)
    expect(isPublicPath("/api/public/to-dos/complete")).toBe(true)
    expect(isPublicPath("/api/public/to-dos/request-fresh-link")).toBe(true)
    expect(isPublicPath("/_pf/app-icons/favicon.ico")).toBe(true)
    expect(isPublicPath("/_pf/public-form-branding/logo.svg")).toBe(true)
    expect(isPublicPath("/manifest.webmanifest")).toBe(true)
  })
})

describe("public todo GraphQL errors", () => {
  test("identifies public todo link errors", () => {
    expect(
      isPublicTodoLinkError(publicTodoGraphqlError("PublicTodoTokenError")),
    ).toBe(true)
    expect(isPublicTodoLinkError(publicTodoGraphqlError("NotAuthorized"))).toBe(
      true,
    )
    expect(isPublicTodoLinkError(publicTodoGraphqlError("InternalError"))).toBe(
      false,
    )
    expect(isPublicTodoLinkError(new Error("backend unavailable"))).toBe(false)
  })
})

describe("public form branding card", () => {
  test("renders children without branding landmarks when branding is absent", async () => {
    const { PublicFormBrandingCard } = await import(
      "../app/public/form/[token]/public-form-branding-card"
    )

    const markup = renderToStaticMarkup(
      createElement(PublicFormBrandingCard, { branding: null }, "Form content"),
    )

    expect(markup).toContain("Form content")
    expect(markup).not.toContain("<header")
    expect(markup).not.toContain("<footer")
  })

  test("renders raw branding HTML and activates scripts", async () => {
    const dom = new JSDOM('<div id="root"></div>', {
      url: "https://example.com/public/form/token-1",
    })
    const container = dom.window.document.getElementById("root")
    if (!container) {
      throw new Error("Missing test root")
    }

    const originalWindow = globalThis.window
    const originalDocument = globalThis.document
    const originalHTMLElement = globalThis.HTMLElement
    const originalActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT
    const stubGlobal = (key: string, value: unknown) => {
      Object.defineProperty(globalThis, key, {
        configurable: true,
        value,
        writable: true,
      })
    }
    const restoreGlobal = (key: string, value: unknown) => {
      if (value === undefined) {
        Reflect.deleteProperty(globalThis, key)
        return
      }

      stubGlobal(key, value)
    }

    stubGlobal("window", dom.window)
    stubGlobal("document", dom.window.document)
    stubGlobal("HTMLElement", dom.window.HTMLElement)
    stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
    const originalCreateElement = dom.window.document.createElement.bind(
      dom.window.document,
    )
    let activatedScriptCount = 0
    dom.window.document.createElement = ((tagName, options) => {
      const element = originalCreateElement(tagName, options)
      if (tagName.toLowerCase() === "script") {
        activatedScriptCount += 1
      }
      return element
    }) as typeof dom.window.document.createElement

    try {
      const { PublicFormBrandingCard } = await import(
        "../app/public/form/[token]/public-form-branding-card"
      )
      const root = createRoot(container)

      await act(async () => {
        root.render(
          createElement(
            PublicFormBrandingCard,
            {
              branding: {
                headerHtml:
                  "<strong>School</strong><script>window.__publicFormBrandingRan = (window.__publicFormBrandingRan || 0) + 1</script>",
                footerHtml: '<a href="mailto:admin@example.com">Email us</a>',
              },
            },
            "Form content",
          ),
        )
      })

      expect(container.textContent).toContain("School")
      expect(container.textContent).toContain("Form content")
      expect(activatedScriptCount).toBe(1)

      await act(async () => {
        root.unmount()
      })
    } finally {
      restoreGlobal("window", originalWindow)
      restoreGlobal("document", originalDocument)
      restoreGlobal("HTMLElement", originalHTMLElement)
      restoreGlobal("IS_REACT_ACT_ENVIRONMENT", originalActEnvironment)
    }
  })
})

describe("public form error", () => {
  test("renders public form branding instead of generic product label", async () => {
    const { PublicFormBrandingProvider } = await import(
      "../app/public/form/[token]/public-form-branding-context"
    )
    const { default: PublicFormError } = await import(
      "../app/public/form/[token]/error"
    )

    const markup = renderToStaticMarkup(
      createElement(
        PublicFormBrandingProvider,
        {
          branding: {
            headerHtml: "<strong>Example School</strong>",
          },
        },
        createElement(PublicFormError, {
          error: new Error("failed"),
          retry: () => {},
        }),
      ),
    )

    expect(markup).toContain("Example School")
    expect(markup).not.toContain("Process Focus")
  })
})

describe("public todo model", () => {
  test("returns standalone copy for completed and expired states", () => {
    expect(publicTodoStateCopy("COMPLETED").title).toBe(
      "This form has already been submitted",
    )
    expect(publicTodoStateCopy("COMPLETED").description).toBe(
      "Contact the sender if you need to make changes.",
    )
    expect(publicTodoStateCopy("EXPIRED").title).toBe("This link has expired")
    expect(publicTodoStateCopy("UNAVAILABLE").title).toBe("Invalid link")
  })

  test("uses the mutation result status after public submission", () => {
    expect(publicTodoTerminalStatusFromResult({ status: "EXPIRED" })).toBe(
      "EXPIRED",
    )
    expect(publicTodoTerminalStatusFromResult({ status: "UNAVAILABLE" })).toBe(
      "UNAVAILABLE",
    )
    expect(publicTodoTerminalStatusFromResult({ status: "ACTIVE" })).toBe(
      "COMPLETED",
    )
  })

  test("allows embedded-safe form components", () => {
    expect(
      publicTodoUnsupportedComponentTypes({
        components: {
          name: {
            _tag: FormComponentType.Text,
            field: "name",
            label: "Name",
          },
          agree: {
            _tag: FormComponentType.Boolean,
            field: "agree",
            label: "Agree",
          },
        },
        rules: [],
      }),
    ).toEqual([])
  })

  test("fails safely for unsupported public form components", () => {
    expect(
      publicTodoUnsupportedComponentTypes({
        components: {
          details: {
            _tag: FormComponentType.FieldSet,
            label: "Details",
            children: {
              attachment: {
                _tag: FormComponentType.File,
                field: "details.attachment",
                label: "Attachment",
                documentStore: "documents",
              },
              assignee: {
                _tag: FormComponentType.ProviderUser,
                field: "details.assignee",
                label: "Assignee",
              },
            },
          },
        },
        rules: [],
      }),
    ).toEqual(["file", "provider-user"])
  })

  test("allows independent lookup components in public forms", () => {
    expect(
      publicTodoUnsupportedComponentTypes({
        components: {
          selectedSlot: {
            _tag: FormComponentType.Lookup,
            field: "selectedSlot",
            label: "Meeting slot",
          },
        },
        rules: [],
      }),
    ).toEqual([])
  })

  test("allows calendar slot components in public forms", () => {
    expect(
      publicTodoUnsupportedComponentTypes({
        components: {
          selectedSlot: {
            _tag: FormComponentType.CalendarSlot,
            field: "selectedSlot",
            label: "Meeting slot",
            timeZone: "Pacific/Auckland",
            locale: "en-NZ",
          },
        },
        rules: [
          {
            condition: {
              _tag: "present",
              value: { _tag: "field", path: ["selectedSlot"] },
            },
            effects: [{ target: ["selectedSlot"], state: { required: true } }],
          },
        ],
      }),
    ).toEqual([])
  })

  test("fails safely for dependent public lookup components", () => {
    expect(
      publicTodoUnsupportedComponentTypes({
        components: {
          selectedClass: {
            _tag: FormComponentType.Lookup,
            field: "selectedClass",
            label: "Class",
            dependencies: ["school"],
            queryName: "lookupSchoolClass",
          },
        },
        rules: [],
      }),
    ).toEqual(["dependent-lookup"])
  })

  test("rejects malformed public form definitions before rendering", () => {
    const malformedDefinition = {
      components: { selectedSlot: [] },
      rules: [],
    }

    expect(() => parseClientFormDefinition(malformedDefinition)).toThrow(
      "must be a valid client form definition",
    )
    expect(parsePublicTodoFormDefinition(malformedDefinition)).toEqual({
      formDefinitionStatus: "malformed",
      formDefinition: null,
    })
  })

  test("ignores non-object default values", () => {
    expect(publicTodoDefaultValues(null)).toBeNull()
    expect(publicTodoDefaultValues("bad")).toBeNull()
    expect(publicTodoDefaultValues({ name: "Ada" })).toEqual({ name: "Ada" })
  })
})

describe("public todo completion api", () => {
  test("submits through the public completion mutation", async () => {
    completePublicTodo.mockResolvedValueOnce({
      todoId: "todo-1",
      status: "COMPLETED",
      formMetadata: null,
    })
    const { POST } = await import("../app/api/public/to-dos/complete/route")

    const response = await POST(
      new Request("https://example.com/api/public/to-dos/complete", {
        method: "POST",
        body: JSON.stringify({ token: "token-1", values: { name: "Ada" } }),
      }),
    )

    await expect(response.json()).resolves.toEqual({
      todo: { todoId: "todo-1", status: "COMPLETED", formMetadata: null },
    })
    expect(completePublicTodo).toHaveBeenCalledWith("token-1", { name: "Ada" })
  })

  test("returns field errors from public completion validation", async () => {
    completePublicTodo.mockRejectedValueOnce(new Error("validation"))
    const { POST } = await import("../app/api/public/to-dos/complete/route")

    const response = await POST(
      new Request("https://example.com/api/public/to-dos/complete", {
        method: "POST",
        body: JSON.stringify({ token: "token-1", values: {} }),
      }),
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      errors: [{ field: "name", message: "Name is required" }],
    })
  })

  test("returns 500 for public todo configuration errors", async () => {
    const { PublicTodoConfigurationError } = await import(
      "../lib/public-todo-server"
    )
    completePublicTodo.mockRejectedValueOnce(new PublicTodoConfigurationError())
    const { POST } = await import("../app/api/public/to-dos/complete/route")

    const response = await POST(
      new Request("https://example.com/api/public/to-dos/complete", {
        method: "POST",
        body: JSON.stringify({ token: "token-1", values: {} }),
      }),
    )

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({
      error: "Public form service is not configured.",
    })
  })

  test("returns a generic message for backend submission errors", async () => {
    completePublicTodo.mockRejectedValueOnce(new Error("secret backend detail"))
    const { POST } = await import("../app/api/public/to-dos/complete/route")

    const response = await POST(
      new Request("https://example.com/api/public/to-dos/complete", {
        method: "POST",
        body: JSON.stringify({ token: "token-1", values: {} }),
      }),
    )

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({
      error: "Unable to submit this form. Please try again.",
    })
  })
})

describe("public todo fresh-link api", () => {
  test("rejects malformed fresh-link payloads", async () => {
    const { POST } = await import(
      "../app/api/public/to-dos/request-fresh-link/route"
    )

    const noBody = await POST(
      new Request("https://example.com/api/public/to-dos/request-fresh-link", {
        method: "POST",
      }),
    )
    const badToken = await POST(
      new Request("https://example.com/api/public/to-dos/request-fresh-link", {
        method: "POST",
        body: JSON.stringify({ token: 123 }),
      }),
    )

    expect(noBody.status).toBe(400)
    await expect(noBody.json()).resolves.toEqual({
      error: "Invalid public form fresh-link payload.",
    })
    expect(badToken.status).toBe(400)
    await expect(badToken.json()).resolves.toEqual({
      error: "Invalid public form fresh-link payload.",
    })
    expect(requestFreshPublicTodoLink).not.toHaveBeenCalled()
  })

  test("requests a fresh public todo link", async () => {
    requestFreshPublicTodoLink.mockResolvedValueOnce({
      todoId: "todo-1",
      status: "ACTIVE",
    })
    const { POST } = await import(
      "../app/api/public/to-dos/request-fresh-link/route"
    )

    const response = await POST(
      new Request("https://example.com/api/public/to-dos/request-fresh-link", {
        method: "POST",
        body: JSON.stringify({ token: "token-1" }),
      }),
    )

    await expect(response.json()).resolves.toEqual({
      todo: { todoId: "todo-1", status: "ACTIVE" },
    })
    expect(requestFreshPublicTodoLink).toHaveBeenCalledWith("token-1")
  })

  test("returns 500 for fresh-link configuration errors", async () => {
    const { PublicTodoConfigurationError } = await import(
      "../lib/public-todo-server"
    )
    requestFreshPublicTodoLink.mockRejectedValueOnce(
      new PublicTodoConfigurationError(),
    )
    const { POST } = await import(
      "../app/api/public/to-dos/request-fresh-link/route"
    )

    const response = await POST(
      new Request("https://example.com/api/public/to-dos/request-fresh-link", {
        method: "POST",
        body: JSON.stringify({ token: "token-1" }),
      }),
    )

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({
      error: "Public form service is not configured.",
    })
  })
})

describe("public todo lookup api", () => {
  test("rejects malformed lookup payloads", async () => {
    const { POST } = await import("../app/api/public/to-dos/lookup/route")

    const response = await POST(
      new Request("https://example.com/api/public/to-dos/lookup", {
        method: "POST",
        body: JSON.stringify({ token: "token-1" }),
      }),
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: "Invalid public form lookup payload.",
    })
    expect(publicTodoLookupSuggestions).not.toHaveBeenCalled()
  })

  test.each([
    ["non-string token", { token: 123, field: "selectedSlot" }],
    [
      "numeric filter",
      { token: "token-1", field: "selectedSlot", filter: 123 },
    ],
    ["negative limit", { token: "token-1", field: "selectedSlot", limit: -1 }],
    ["float limit", { token: "token-1", field: "selectedSlot", limit: 1.5 }],
    [
      "limit above maximum",
      { token: "token-1", field: "selectedSlot", limit: 101 },
    ],
  ])("rejects invalid lookup payload fields: %s", async (_name, payload) => {
    publicTodoLookupSuggestions.mockClear()
    const { POST } = await import("../app/api/public/to-dos/lookup/route")

    const response = await POST(
      new Request("https://example.com/api/public/to-dos/lookup", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: "Invalid public form lookup payload.",
    })
    expect(publicTodoLookupSuggestions).not.toHaveBeenCalled()
  })

  test("loads public todo lookup suggestions", async () => {
    publicTodoLookupSuggestions.mockResolvedValueOnce([
      { value: "slot-1", label: "Monday 09:00" },
    ])
    const { POST } = await import("../app/api/public/to-dos/lookup/route")

    const response = await POST(
      new Request("https://example.com/api/public/to-dos/lookup", {
        method: "POST",
        body: JSON.stringify({
          token: "token-1",
          field: "selectedSlot",
          filter: "mon",
          limit: 10,
        }),
      }),
    )

    await expect(response.json()).resolves.toEqual({
      items: [{ value: "slot-1", label: "Monday 09:00" }],
    })
    expect(publicTodoLookupSuggestions).toHaveBeenCalledWith(
      "token-1",
      "selectedSlot",
      "mon",
      10,
    )
  })

  test("returns configuration errors from lookup endpoint", async () => {
    const { PublicTodoConfigurationError } = await import(
      "../lib/public-todo-server"
    )
    publicTodoLookupSuggestions.mockRejectedValueOnce(
      new PublicTodoConfigurationError(),
    )
    const { POST } = await import("../app/api/public/to-dos/lookup/route")

    const response = await POST(
      new Request("https://example.com/api/public/to-dos/lookup", {
        method: "POST",
        body: JSON.stringify({ token: "token-1", field: "selectedSlot" }),
      }),
    )

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({
      error: "Public form service is not configured.",
    })
  })
})

describe("public todo calendar slots api", () => {
  test("rejects malformed calendar slot payloads", async () => {
    const { POST } = await import(
      "../app/api/public/to-dos/calendar-slots/route"
    )

    const response = await POST(
      new Request("https://example.com/api/public/to-dos/calendar-slots", {
        method: "POST",
        body: JSON.stringify({ token: "token-1" }),
      }),
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: "Invalid public form calendar slots payload.",
    })
    expect(publicTodoCalendarSlots).not.toHaveBeenCalled()
  })

  test("loads public todo calendar slots", async () => {
    publicTodoCalendarSlots.mockResolvedValueOnce([
      {
        value: "slot-1",
        startsAt: "2026-05-05T10:00:00+12:00",
        endsAt: "2026-05-05T10:30:00+12:00",
      },
    ])
    const { POST } = await import(
      "../app/api/public/to-dos/calendar-slots/route"
    )

    const response = await POST(
      new Request("https://example.com/api/public/to-dos/calendar-slots", {
        method: "POST",
        body: JSON.stringify({ token: "token-1", field: "selectedSlot" }),
      }),
    )

    await expect(response.json()).resolves.toEqual({
      items: [
        {
          value: "slot-1",
          startsAt: "2026-05-05T10:00:00+12:00",
          endsAt: "2026-05-05T10:30:00+12:00",
        },
      ],
    })
    expect(publicTodoCalendarSlots).toHaveBeenCalledWith(
      "token-1",
      "selectedSlot",
    )
  })
})

describe("public todo client", () => {
  test("renders submitted message after successful completion", async () => {
    const dom = new JSDOM('<div id="root"></div>')
    const container = dom.window.document.getElementById("root")
    if (!container) {
      throw new Error("Missing test root")
    }

    dynamicForm.mockImplementationOnce(
      (props: {
        readonly handleSubmit: (
          values: Record<string, unknown>,
        ) => Promise<unknown>
      }) =>
        createElement(
          "button",
          {
            type: "button",
            onClick: () => void props.handleSubmit({ name: "Ada" }),
          },
          "Submit",
        ),
    )
    const originalWindow = globalThis.window
    const originalDocument = globalThis.document
    const originalHTMLElement = globalThis.HTMLElement
    const originalNavigator = globalThis.navigator
    const originalFetch = globalThis.fetch
    const originalActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT
    const stubGlobal = (key: string, value: unknown) => {
      Object.defineProperty(globalThis, key, {
        configurable: true,
        value,
        writable: true,
      })
    }
    const restoreGlobal = (key: string, value: unknown) => {
      if (value === undefined) {
        Reflect.deleteProperty(globalThis, key)
        return
      }

      stubGlobal(key, value)
    }

    stubGlobal("window", dom.window)
    stubGlobal("document", dom.window.document)
    stubGlobal("HTMLElement", dom.window.HTMLElement)
    stubGlobal("navigator", dom.window.navigator)
    stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
    stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            todo: {
              todoId: "todo-1",
              status: "COMPLETED",
              completionMessage: "Thanks for submitting.",
            },
          }),
        ),
      ),
    )

    try {
      const { PublicTodoClient } = await import(
        "../app/public/form/[token]/public-todo-client"
      )
      const root = createRoot(container)

      await act(async () => {
        root.render(
          createElement(PublicTodoClient, {
            token: "token-1",
            todoId: "todo-1",
            submittedTitle: "Test Org",
            formMetadata: {
              stepPath: "/ops/todo/Complete",
              processName: "Enrolment Enquiry",
              formDefinitionStatus: "parsed",
              formDefinition: { components: {}, rules: [] },
              defaultValues: {},
              jsonSchema: {},
            },
          }),
        )
      })

      await act(async () => {
        container
          .querySelector("button")
          ?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }))
      })

      expect(container.textContent).toContain("Submitted")
      expect(container.textContent).toContain("Test Org")
      expect(container.textContent).toContain("Thanks for submitting.")

      await act(async () => {
        root.unmount()
      })
    } finally {
      dynamicForm.mockImplementation(() => "Submit")
      restoreGlobal("window", originalWindow)
      restoreGlobal("document", originalDocument)
      restoreGlobal("HTMLElement", originalHTMLElement)
      restoreGlobal("navigator", originalNavigator)
      restoreGlobal("fetch", originalFetch)
      restoreGlobal("IS_REACT_ACT_ENVIRONMENT", originalActEnvironment)
    }
  })
})

describe("public todo page", () => {
  const renderPublicTodoContent = async (token: string) => {
    const { PublicTodoContent } = await import(
      "../app/public/form/[token]/page"
    )

    return renderToStaticMarkup(
      await PublicTodoContent({
        params: Promise.resolve({ token }),
        publicFormBranding: null,
      }),
    )
  }

  test("renders a ready public todo as a standalone form", async () => {
    fetchPublicTodo.mockResolvedValueOnce({
      todoId: "todo-1",
      status: "ACTIVE",
      formMetadata: {
        stepPath: "/onboarding/Confirm details",
        processName: "Onboarding",
        publicFormTitle: "Confirm your details",
        publicFormDescription: "Check your details and submit the form.",
        formDefinitionStatus: "parsed",
        formDefinition: null,
        defaultValues: null,
        jsonSchema: null,
      },
    })
    const markup = await renderPublicTodoContent("token-1")

    expect(markup).not.toContain("Public to-do")
    expect(markup).toContain("Confirm your details")
    expect(markup).toContain("Check your details and submit the form.")
    expect(markup).not.toContain("Submit this form to continue the process.")
    expect(markup).toContain("Submit")
    expect(markup).not.toContain("Dashboard")
  })

  test("disables provider-user lookup for public todo forms", async () => {
    dynamicForm.mockClear()
    fetchPublicTodo.mockResolvedValueOnce({
      todoId: "todo-1",
      status: "ACTIVE",
      formMetadata: {
        stepPath: "/onboarding/Confirm details",
        processName: "Onboarding",
        formDefinitionStatus: "parsed",
        formDefinition: null,
        defaultValues: null,
        jsonSchema: null,
      },
    })
    await renderPublicTodoContent("token-1")

    expect(dynamicForm).toHaveBeenCalledWith(
      expect.objectContaining({ enableProviderUserLookup: false }),
    )
  })

  test("passes lookup components through to public todo forms", async () => {
    dynamicForm.mockClear()
    fetchPublicTodo.mockResolvedValueOnce({
      todoId: "todo-1",
      status: "ACTIVE",
      formMetadata: {
        stepPath: "/onboarding/Choose slot",
        processName: "Onboarding",
        formDefinitionStatus: "parsed",
        formDefinition: {
          components: {
            selectedSlot: {
              _tag: FormComponentType.Lookup,
              field: "selectedSlot",
              label: "Meeting slot",
            },
          },
          rules: [],
        },
        defaultValues: null,
        jsonSchema: null,
      },
    })
    const markup = await renderPublicTodoContent("token-1")

    expect(markup).not.toContain("This form cannot be opened here")
    expect(dynamicForm).toHaveBeenCalledWith(
      expect.objectContaining({
        formDefinition: expect.objectContaining({
          components: expect.objectContaining({
            selectedSlot: expect.objectContaining({
              _tag: FormComponentType.Lookup,
            }),
          }),
        }),
      }),
    )
  })

  test("renders expired and completed standalone states", async () => {
    fetchPublicTodo.mockResolvedValueOnce({
      todoId: "todo-1",
      status: "EXPIRED",
      formMetadata: null,
    })
    const expired = await renderPublicTodoContent("expired")
    expect(expired).toContain("This link has expired")

    fetchPublicTodo.mockResolvedValueOnce({
      todoId: "todo-1",
      status: "COMPLETED",
      formMetadata: null,
    })
    const completed = await renderPublicTodoContent("done")
    expect(completed).toContain("This form has already been submitted")
  })

  test("renders unavailable public todo status", async () => {
    fetchPublicTodo.mockResolvedValueOnce({
      todoId: "todo-1",
      status: "UNAVAILABLE",
      formMetadata: null,
    })
    const markup = await renderPublicTodoContent("token-1")

    expect(markup).toContain("Invalid link")
    expect(markup).toContain(
      "This link is invalid. Contact the sender for help.",
    )
  })

  test("renders unavailable when an active todo has no form metadata", async () => {
    fetchPublicTodo.mockResolvedValueOnce({
      todoId: "todo-1",
      status: "ACTIVE",
      formMetadata: null,
    })
    const markup = await renderPublicTodoContent("token-1")

    expect(markup).toContain("Temporarily unavailable")
    expect(markup).toContain(
      "This form is temporarily unavailable. Try again later.",
    )
  })

  test("renders not found for unresolved public todo tokens", async () => {
    fetchPublicTodo.mockRejectedValueOnce(
      publicTodoGraphqlError("PublicTodoTokenError"),
    )
    const { PublicTodoContent } = await import(
      "../app/public/form/[token]/page"
    )

    await expect(
      PublicTodoContent({
        params: Promise.resolve({ token: "bad" }),
        publicFormBranding: null,
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND")
    expect(notFound).toHaveBeenCalled()
  })

  test("does not hide public todo backend errors as not found", async () => {
    const error = new Error("backend unavailable")
    notFound.mockClear()
    fetchPublicTodo.mockRejectedValueOnce(error)
    const { PublicTodoContent } = await import(
      "../app/public/form/[token]/page"
    )

    await expect(
      PublicTodoContent({
        params: Promise.resolve({ token: "token-1" }),
        publicFormBranding: null,
      }),
    ).rejects.toBe(error)
    expect(notFound).not.toHaveBeenCalled()
  })

  test("does not hide public todo configuration errors as not found", async () => {
    const { PublicTodoConfigurationError } = await import(
      "../lib/public-todo-server"
    )
    fetchPublicTodo.mockRejectedValueOnce(new PublicTodoConfigurationError())
    const { PublicTodoContent } = await import(
      "../app/public/form/[token]/page"
    )

    await expect(
      PublicTodoContent({
        params: Promise.resolve({ token: "token-1" }),
        publicFormBranding: null,
      }),
    ).rejects.toBeInstanceOf(PublicTodoConfigurationError)
  })
})
