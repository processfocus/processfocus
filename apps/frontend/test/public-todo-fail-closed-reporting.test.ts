import { JSDOM } from "jsdom"
import { act, createElement } from "react"
import { type Root, createRoot } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { FormComponentType } from "@pf/form-client-representation/types"
import { PublicTodoClient } from "../app/public/form/[token]/public-todo-client"
import { FrontendClientPluginProvider } from "../components/frontend-client-plugin-provider"
import {
  clearFrontendClientPlugins,
  registerFrontendClientPlugin,
} from "../lib/frontend-client-plugin-registry"
import type { FrontendManifestAnalyticsPlugin } from "../lib/frontend-manifest"

vi.mock("@/lib/public-todo-form-runtime", () => ({
  dynamicForm: vi.fn(() => "Submit"),
  LookupProvider: ({ children }: { readonly children: unknown }) => children,
}))

const analyticsPlugin: FrontendManifestAnalyticsPlugin = {
  type: "analytics.test",
  config: {},
}

const unsupportedPublicTodo = {
  token: "secret-capability-token",
  todoId: "todo-1",
  submittedTitle: "Test Organisation",
  formMetadata: {
    stepPath: "/enrolment/Upload documents",
    processName: "Enrolment",
    publicFormDescription:
      "Private Recipient should visit https://example.com/public/form/secret-capability-token",
    formDefinitionStatus: "parsed",
    formDefinition: {
      components: {
        document: {
          _tag: FormComponentType.File,
          field: "document",
          label: "Document",
          documentStore: "documents",
        },
      },
      rules: [],
    },
    defaultValues: { studentName: "Private Form Value" },
    jsonSchema: {},
  },
} as const

const installDom = () => {
  const dom = new JSDOM('<div id="root"></div>')
  const container = dom.window.document.getElementById("root")
  if (!container) {
    throw new Error("Missing test root")
  }

  const previousGlobals = {
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    navigator: globalThis.navigator,
    window: globalThis.window,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  }

  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    navigator: dom.window.navigator,
    window: dom.window,
    IS_REACT_ACT_ENVIRONMENT: true,
  })

  return {
    container,
    cleanup: () => {
      dom.window.close()
      Object.assign(globalThis, previousGlobals)
    },
  }
}

describe("public todo fail-closed reporting", () => {
  let cleanupDom: (() => void) | undefined
  let container: HTMLElement
  let root: Root

  beforeEach(() => {
    const dom = installDom()
    cleanupDom = dom.cleanup
    container = dom.container
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    clearFrontendClientPlugins()
    cleanupDom?.()
  })

  const renderPublicTodo = async (
    plugins: ReadonlyArray<FrontendManifestAnalyticsPlugin>,
    props: Parameters<typeof PublicTodoClient>[0] = unsupportedPublicTodo,
  ) => {
    await act(async () => {
      root.render(
        createElement(
          FrontendClientPluginProvider,
          { plugins },
          createElement(PublicTodoClient, props),
        ),
      )
    })
  }

  test("reports sanitized diagnostics once when a plugin becomes active", async () => {
    const captured: Array<{
      readonly error: Error
      readonly properties: Record<string, unknown> | undefined
    }> = []
    registerFrontendClientPlugin({
      type: analyticsPlugin.type,
      render: () => null,
      captureClientException(_config, error, properties) {
        captured.push({ error, properties })
      },
    })

    await renderPublicTodo([])

    expect(captured).toEqual([])
    expect(container.textContent).toContain("This form cannot be opened here")
    expect(container.textContent).toContain(
      "This public form contains unsupported fields (file). Contact the sender for another way to complete it.",
    )

    await renderPublicTodo([analyticsPlugin])
    await renderPublicTodo([analyticsPlugin])

    expect(captured).toEqual([
      {
        error: expect.objectContaining({
          message: "Public form client metadata is unsupported or malformed.",
        }),
        properties: {
          public_form_action: "fail-closed",
          public_form_failure_reason: "unsupported_component_types",
          public_form_process_name: "Enrolment",
          public_form_step_path: "/enrolment/Upload documents",
          public_form_todo_id: "todo-1",
          public_form_unsupported_component_types: ["file"],
        },
      },
    ])

    const telemetry = JSON.stringify({
      message: captured[0]?.error.message,
      properties: captured[0]?.properties,
    })
    expect(telemetry).not.toContain("secret-capability-token")
    expect(telemetry).not.toContain("Private Recipient")
    expect(telemetry).not.toContain("Private Form Value")
    expect(telemetry).not.toContain("https://example.com")
  })

  test("reports each distinct failure state at most once per mount", async () => {
    const capturedTypes: Array<unknown> = []
    registerFrontendClientPlugin({
      type: analyticsPlugin.type,
      render: () => null,
      captureClientException(_config, _error, properties) {
        capturedTypes.push(
          properties?.["public_form_unsupported_component_types"],
        )
      },
    })
    const alternateFailure = {
      ...unsupportedPublicTodo,
      formMetadata: {
        ...unsupportedPublicTodo.formMetadata,
        formDefinition: {
          components: {
            assignee: {
              _tag: FormComponentType.ProviderUser,
              field: "assignee",
              label: "Assignee",
            },
          },
          rules: [],
        },
      },
    }

    await renderPublicTodo([analyticsPlugin])
    await renderPublicTodo([analyticsPlugin], alternateFailure)
    await renderPublicTodo([analyticsPlugin])

    expect(capturedTypes).toEqual([["file"], ["provider-user"]])
  })

  test("keeps rendering the friendly state when no plugin is active", async () => {
    await expect(renderPublicTodo([])).resolves.toBeUndefined()

    expect(container.textContent).toContain("This form cannot be opened here")
    expect(container.textContent).toContain(
      "This public form contains unsupported fields (file). Contact the sender for another way to complete it.",
    )
  })

  test("identifies malformed metadata without reporting its contents", async () => {
    const captured: Array<Record<string, unknown> | undefined> = []
    registerFrontendClientPlugin({
      type: analyticsPlugin.type,
      render: () => null,
      captureClientException(_config, _error, properties) {
        captured.push(properties)
      },
    })

    await renderPublicTodo([analyticsPlugin], {
      ...unsupportedPublicTodo,
      formMetadata: {
        ...unsupportedPublicTodo.formMetadata,
        formDefinitionStatus: "malformed",
        formDefinition: null,
      },
    })

    expect(captured).toEqual([
      {
        public_form_action: "fail-closed",
        public_form_failure_reason: "malformed_client_form_metadata",
        public_form_process_name: "Enrolment",
        public_form_step_path: "/enrolment/Upload documents",
        public_form_todo_id: "todo-1",
        public_form_unsupported_component_types: ["unknown"],
      },
    ])
    expect(JSON.stringify(captured)).not.toContain("secret metadata contents")
    expect(container.textContent).toContain("This form cannot be opened here")
    expect(container.textContent).toContain(
      "This public form contains unsupported fields (unknown). Contact the sender for another way to complete it.",
    )
  })

  test("reports malformed structured metadata without exposing its contents", async () => {
    const captured: Array<Record<string, unknown> | undefined> = []
    registerFrontendClientPlugin({
      type: analyticsPlugin.type,
      render: () => null,
      captureClientException(_config, _error, properties) {
        captured.push(properties)
      },
    })

    await renderPublicTodo([analyticsPlugin], {
      ...unsupportedPublicTodo,
      formMetadata: {
        ...unsupportedPublicTodo.formMetadata,
        formDefinitionStatus: "malformed",
        formDefinition: null,
      },
    })

    expect(captured).toEqual([
      expect.objectContaining({
        public_form_failure_reason: "malformed_client_form_metadata",
        public_form_unsupported_component_types: ["unknown"],
      }),
    ])
    expect(JSON.stringify(captured)).not.toContain("secret-capability-token")
    expect(container.textContent).toContain("This form cannot be opened here")
  })

  test("isolates plugin failures from the friendly state", async () => {
    registerFrontendClientPlugin({
      type: analyticsPlugin.type,
      render: () => null,
      captureClientException: () => {
        throw new Error("analytics unavailable")
      },
    })

    await expect(renderPublicTodo([analyticsPlugin])).resolves.toBeUndefined()

    expect(container.textContent).toContain("This form cannot be opened here")
    expect(container.textContent).toContain(
      "This public form contains unsupported fields (file). Contact the sender for another way to complete it.",
    )
  })
})
