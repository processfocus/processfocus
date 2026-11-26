import { createCollection, localOnlyCollectionOptions } from "@tanstack/db"
import { Schema } from "effect"
import { JSDOM } from "jsdom"
import { type ReactNode, act } from "react"
import type { Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { LookupProvider, type LookupService } from "@pf/form"
import { BooleanField, LookupField, TextField } from "@pf/form-schema"
import { withFormRules } from "@pf/form-submission-schema"
import { StartProcessForm } from "../app/(protected)/processes/components/start-process-form"
import { WorkflowFormPreviewSheet } from "../app/(protected)/processes/workflow/[...processPath]/workflow-form-preview-sheet"
import { CompleteTodoForm } from "../app/(protected)/to-dos/components/complete-todo-form"
import type { DraftProcessExecutionDocType } from "../lib/collections/draft-process-execution"
import { FORM_METADATA_QUERY } from "../lib/graphql/queries"

const graphqlRequest = vi.fn()
const draftCollection = createCollection(
  localOnlyCollectionOptions<DraftProcessExecutionDocType>({
    getKey: (row) => row.id,
  }),
)
const draftCollectionPromise = Promise.resolve(draftCollection)
let workflowFormMetadata: ReturnType<typeof formMetadata>

vi.mock("@/lib/graphql/client-provider", () => ({
  useGraphqlClient: () => ({ request: graphqlRequest }),
}))

vi.mock(
  "@/lib/collections/draft-process-execution-collection-provider",
  () => ({
    DraftProcessCollectionProvider: ({ children }: { children: ReactNode }) =>
      children,
    useDraftProcessCollection: () => ({
      collectionPromise: draftCollectionPromise,
      initialSync: { status: "complete" },
    }),
  }),
)

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

const ruleBearingDefinition = (detailsLabel: string) =>
  withFormRules(
    Schema.Struct({
      status: BooleanField({ label: "Status" }),
      details: TextField({ label: detailsLabel }),
    }),
    (values) => ({ details: { hidden: values.status === true } }),
  )
let browserSchema = ruleBearingDefinition("Preview-only details")
let browserPromise = Promise.resolve(browserSchema)
const selectSchema = (schema: typeof browserSchema) => {
  browserSchema = schema
  browserPromise = Promise.resolve(schema)
}
vi.mock("@/lib/frontend-form-loaders", () => ({
  loadBrowserFormDefinition: () => browserPromise,
}))
const formMetadata = (_definition: unknown) => ({
  stepPath: "/operations/example/Review",
  processName: "Example process",
  stepName: "Review",
  processPath: "/operations/example",
  mutationName: "startExample",
  inputTypeName: "ExampleInput",
  completeMutationName: "completeExample",
  totalFields: 2,
  defaultValues: { status: true, details: "private" },
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
    const checkbox = container.querySelector<HTMLInputElement>(
      `input#${name}[type="checkbox"]`,
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
    vi.useRealTimers()
    await act(async () => root.unmount())
    cleanupDom?.()
    vi.clearAllMocks()
  })

  test("the authenticated metadata query selects only the structured definition", () => {
    const query = FORM_METADATA_QUERY

    expect(query).not.toContain("formDefinition")
    expect(query).not.toContain("jsonSchema")
    expect(query).not.toContain("clientRepresentation")
    expect(query).not.toMatch(/^\s*rules\s*$/m)
  })

  test("process start renders components and projects rules from the definition", async () => {
    selectSchema(ruleBearingDefinition("Start-only details"))
    const onClose = vi.fn()

    await act(async () => {
      root.render(
        <StartProcessForm
          processId="process-example"
          canSkipScheduleWaits={false}
          startStepPath="/operations/example/Start"
          mutationName="startExample"
          inputTypeName="ExampleInput"
          defaultValues={{ status: true, details: "private" }}
          processName="Example process"
          totalFields={2}
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
    vi.useFakeTimers()
    selectSchema(
      withFormRules(
        Schema.Struct({
          ...ruleBearingDefinition("State-aware todo details").fields,
          reviewer: Schema.optional(LookupField({ label: "Reviewer" })),
        }),
        (values) => ({ details: { hidden: values.status === true } }),
      ),
    )
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
            onClose={onClose}
          />
        </LookupProvider>,
      )
    })

    expect(container.textContent).toContain("Status")
    expect(container.textContent).toContain("Reviewer")
    expect(container.textContent).not.toContain("State-aware todo details")
    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    fetchLookupSuggestions.mockClear()
    await act(async () => {
      container
        .querySelector<HTMLInputElement>('input[role="combobox"]')
        ?.click()
    })
    // Commit the click before advancing the debounce scheduled by its effect.
    await act(async () => {
      vi.advanceTimersByTime(350)
    })
    vi.useRealTimers()
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

  test("workflow preview renders shared fields and rules", async () => {
    selectSchema(ruleBearingDefinition("Preview-only details"))
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
