import { JSDOM } from "jsdom"
import { type ReactNode, act } from "react"
import type { Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import {
  type JsonSchemaRoot,
  LookupProvider,
  type LookupService,
} from "@pf/form"
import type { ClientFormDefinition } from "@pf/form-client-representation/client-form-definition"
import { FormComponentType } from "@pf/form-client-representation/types"
import { StartProcessForm } from "../app/(protected)/processes/components/start-process-form"
import { WorkflowFormPreviewSheet } from "../app/(protected)/processes/workflow/[...processPath]/workflow-form-preview-sheet"
import { CompleteTodoForm } from "../app/(protected)/to-dos/components/complete-todo-form"
import { FORM_METADATA_QUERY } from "../lib/graphql/queries"

const graphqlRequest = vi.fn()
let workflowFormMetadata: ReturnType<typeof formMetadata>

vi.mock("@/lib/graphql/client-provider", () => ({
  useGraphqlClient: () => ({ request: graphqlRequest }),
}))

vi.mock(
  "@/lib/collections/draft-process-execution-collection-provider",
  () => ({
    useDraftProcessCollection: () => ({
      collectionPromise: Promise.resolve({
        delete: vi.fn(),
        has: vi.fn(() => false),
      }),
    }),
  }),
)

vi.mock("@/hooks/use-processes-query", () => ({
  useProcessesQuery: () => ({ isLoading: false, processes: [] }),
}))

vi.mock("@/hooks/use-draft-process-save", () => ({
  useDraftProcessSave: () => ({
    draftSaveError: null,
    handleDiscard: vi.fn(),
    handleSaveDraft: vi.fn(),
    showButtonError: false,
  }),
}))

vi.mock("@/hooks/use-form-metadata", () => ({
  useFormMetadata: () => ({
    error: null,
    formMetadata: workflowFormMetadata,
    isLoading: false,
  }),
}))

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children }: { readonly children: ReactNode }) => children,
  SheetContent: ({ children }: { readonly children: ReactNode }) => (
    <div>{children}</div>
  ),
  SheetDescription: ({ children }: { readonly children: ReactNode }) => (
    <p>{children}</p>
  ),
  SheetHeader: ({ children }: { readonly children: ReactNode }) => (
    <header>{children}</header>
  ),
  SheetTitle: ({ children }: { readonly children: ReactNode }) => (
    <h2>{children}</h2>
  ),
}))

const jsonSchema = {
  type: "object",
  properties: {
    status: { type: "boolean" },
    details: { type: "string" },
  },
} satisfies JsonSchemaRoot

const ruleBearingDefinition = (detailsLabel: string): ClientFormDefinition => ({
  components: {
    status: {
      _tag: FormComponentType.Boolean,
      field: "status",
      label: "Status",
    },
    details: {
      _tag: FormComponentType.Text,
      field: "details",
      label: detailsLabel,
    },
  },
  rules: [
    {
      condition: {
        _tag: "equals",
        left: { _tag: "field", path: ["status"] },
        right: { _tag: "literal", value: true },
      },
      effects: [{ target: ["details"], state: { hidden: true } }],
    },
  ],
})

const formMetadata = (formDefinition: ClientFormDefinition) => ({
  stepPath: "/operations/example/Review",
  processName: "Example process",
  stepName: "Review",
  processPath: "/operations/example",
  mutationName: "startExample",
  inputTypeName: "ExampleInput",
  completeMutationName: "completeExample",
  totalFields: 2,
  formDefinition,
  defaultValues: { status: true, details: "private" },
  jsonSchema,
})

const fetchLookupSuggestions = vi.fn(async () => [])

const lookupService: LookupService = {
  fetchSuggestions: fetchLookupSuggestions,
  fetchDependentSuggestions: async () => [],
  fetchCalendarSlots: async () => [],
}

class ResizeObserverStub implements ResizeObserver {
  observe(_target: Element, _options?: ResizeObserverOptions): void {}
  unobserve(_target: Element): void {}
  disconnect(): void {}
}

const installDom = (): (() => void) => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://dashboard.example.com/processes",
  })
  const previousActEnvironmentDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "IS_REACT_ACT_ENVIRONMENT",
  )
  const previousGlobals = {
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    document: globalThis.document,
    Element: globalThis.Element,
    Event: globalThis.Event,
    HTMLElement: globalThis.HTMLElement,
    HTMLInputElement: globalThis.HTMLInputElement,
    getComputedStyle: globalThis.getComputedStyle,
    MutationObserver: globalThis.MutationObserver,
    Node: globalThis.Node,
    navigator: globalThis.navigator,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    ResizeObserver: globalThis.ResizeObserver,
    window: globalThis.window,
  }

  Object.assign(globalThis, {
    cancelAnimationFrame: (handle: number) => dom.window.clearTimeout(handle),
    document: dom.window.document,
    Element: dom.window.Element,
    Event: dom.window.Event,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node,
    navigator: dom.window.navigator,
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      dom.window.setTimeout(() => callback(0), 0),
    ResizeObserver: ResizeObserverStub,
    window: dom.window,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  Object.assign(dom.window.HTMLElement.prototype, {
    attachEvent: () => undefined,
    detachEvent: () => undefined,
  })

  return () => {
    dom.window.close()
    Object.assign(globalThis, previousGlobals)
    if (previousActEnvironmentDescriptor) {
      Object.defineProperty(
        globalThis,
        "IS_REACT_ACT_ENVIRONMENT",
        previousActEnvironmentDescriptor,
      )
    } else {
      Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
    }
  }
}

describe("authenticated structured form definitions", () => {
  let cleanupDom: (() => void) | undefined
  let container: HTMLElement
  let root: Root

  beforeEach(async () => {
    cleanupDom = installDom()
    const rootElement = document.getElementById("root")
    if (!rootElement) throw new Error("Missing test root")
    container = rootElement
    const { createRoot } = await import("react-dom/client")
    root = createRoot(container)
    workflowFormMetadata = formMetadata(
      ruleBearingDefinition("Preview-only details"),
    )
    graphqlRequest.mockResolvedValue({})
  })

  const toggleBooleanField = async (name: string) => {
    const checkbox = container.querySelector<HTMLButtonElement>(
      `button#${name}[role="checkbox"]`,
    )
    if (!checkbox) throw new Error(`Missing ${name} checkbox`)

    await act(async () => {
      checkbox.dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
    })
  }

  const submitForm = async () => {
    const form = container.querySelector("form")
    if (!form) throw new Error("Missing structured form")

    await act(async () => {
      form.dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true }),
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }

  afterEach(async () => {
    await act(async () => root.unmount())
    cleanupDom?.()
    vi.clearAllMocks()
  })

  test("the authenticated metadata query selects only the structured definition", () => {
    const query = FORM_METADATA_QUERY

    expect(query).toContain("formDefinition")
    expect(query).not.toContain("clientRepresentation")
    expect(query).not.toMatch(/^\s*rules\s*$/m)
  })

  test("process start renders components and projects rules from the definition", async () => {
    const formDefinition = ruleBearingDefinition("Start-only details")
    const onClose = vi.fn()

    await act(async () => {
      root.render(
        <StartProcessForm
          startStepPath="/operations/example/Start"
          mutationName="startExample"
          inputTypeName="ExampleInput"
          defaultValues={{ status: true, details: "private" }}
          formDefinition={formDefinition}
          jsonSchema={jsonSchema}
          processName="Example process"
          totalFields={2}
          draftId={undefined}
          onClose={onClose}
        />,
      )
    })

    expect(container.textContent).toContain("Status")
    expect(container.textContent).not.toContain("Start-only details")

    await toggleBooleanField("status")

    expect(container.textContent).toContain("Start-only details")

    await submitForm()

    expect(graphqlRequest).toHaveBeenCalledWith(
      expect.stringContaining("startExample"),
      { input: { details: "private", status: false }, withoutWaiting: false },
    )
    expect(onClose).toHaveBeenCalledOnce()
  })

  test("todo completion renders state-aware components and projects their rules", async () => {
    const baseTodoDefinition = ruleBearingDefinition("State-aware todo details")
    const todoDefinition: ClientFormDefinition = {
      ...baseTodoDefinition,
      components: {
        ...baseTodoDefinition.components,
        reviewer: {
          _tag: FormComponentType.Lookup,
          field: "reviewer",
          label: "Reviewer",
        },
      },
    }
    const onClose = vi.fn()

    await act(async () => {
      root.render(
        <LookupProvider value={lookupService}>
          <CompleteTodoForm
            todoId="todo-1"
            stepPath="/operations/example/Review"
            inputTypeName="ExampleInput"
            completeMutationName="completeExample"
            defaultValues={{ status: true, details: "private" }}
            formDefinition={todoDefinition}
            jsonSchema={{
              ...jsonSchema,
              properties: {
                ...jsonSchema.properties,
                reviewer: { type: "string" },
              },
            }}
            onClose={onClose}
          />
        </LookupProvider>,
      )
    })

    expect(container.textContent).toContain("Status")
    expect(container.textContent).toContain("Reviewer")
    expect(container.textContent).not.toContain("State-aware todo details")
    expect(fetchLookupSuggestions).toHaveBeenCalledWith(
      "/operations/example/Review",
      "reviewer",
      "",
      20,
      { todoId: "todo-1" },
    )

    await toggleBooleanField("status")

    expect(container.textContent).toContain("State-aware todo details")

    await submitForm()

    expect(graphqlRequest).toHaveBeenCalledWith(
      expect.stringContaining("completeExample"),
      {
        todoId: "todo-1",
        input: { details: "private", status: false },
      },
    )
    expect(onClose).toHaveBeenCalledOnce()
  })

  test("workflow preview renders representative state and projects its rules", async () => {
    await act(async () => {
      root.render(
        <WorkflowFormPreviewSheet
          step={{
            id: "step-review",
            name: "Review",
            path: "/operations/example/Review",
            purpose: "Review the example",
            processId: "process-example",
            role: null,
            phase: null,
            isStartStep: false,
            isEmbedded: false,
            column: 1,
          }}
          open
          onOpenChange={vi.fn()}
        />,
      )
    })

    expect(container.textContent).toContain("Status")
    expect(container.textContent).not.toContain("Preview-only details")

    await toggleBooleanField("status")

    expect(container.textContent).toContain("Preview-only details")
  })
})
