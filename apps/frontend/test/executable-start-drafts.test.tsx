import { createCollection, localOnlyCollectionOptions } from "@tanstack/db"
import { Schema } from "effect"
import { buildSchema, graphql } from "graphql"
import { JSDOM } from "jsdom"
import { act } from "react"
import { withFormRules } from "@pf/form-submission-schema"
import { StartProcessForm } from "../app/(protected)/processes/components/start-process-form"
import type { DraftProcessExecutionDocType } from "../lib/collections/draft-process-execution"
import { expect, mock, test } from "bun:test"

const schema = Schema.Struct({
  item: Schema.Trim.check(Schema.isMinLength(1)),
  value: Schema.NumberFromString.check(Schema.isGreaterThan(0)),
})
let schemaPromise: Promise<
  import("@pf/form/effect-schema-form").BrowserFormSchema
> = Promise.resolve(schema)
let request = async (
  _document: string,
  _variables: Record<string, unknown>,
) => ({})
const collection = createCollection(
  localOnlyCollectionOptions<DraftProcessExecutionDocType>({
    getKey: (row) => row.id,
  }),
)
const collectionPromise = Promise.resolve(collection)
mock.module("@/lib/frontend-form-loaders", () => ({
  loadBrowserFormDefinition: () => schemaPromise,
}))
mock.module("@/lib/graphql/client-provider", () => ({
  useGraphqlClient: () => ({ request }),
}))
mock.module(
  "@/lib/collections/draft-process-execution-collection-provider",
  () => ({
    useDraftProcessCollection: () => ({
      collectionPromise,
      initialSync: { status: "complete" },
      db: { name: "draft-test" },
    }),
    DraftProcessCollectionProvider: ({
      children,
    }: {
      children: React.ReactNode
    }) => children,
  }),
)

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
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
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
test("process start edits autosave to one draft, reopen, and discard", async () => {
  const cleanup = installDom()
  const { createRoot } = await import("react-dom/client")
  const container = document.getElementById("root")!
  let root = createRoot(container)
  const draftKey = "process-start-draft-draft-test//purchase/Start"
  window.localStorage.setItem(
    draftKey,
    JSON.stringify({ item: "  Chair  ", value: "-2" }),
  )
  let closed = false
  const render = () =>
    act(async () =>
      root.render(
        <StartProcessForm
          processId="purchase"
          processName="Purchase"
          startStepPath="/purchase/Start"
          mutationName="startPurchase"
          inputTypeName="PurchaseInput"
          defaultValues={{ item: "", value: "" }}
          totalFields={2}
          canSkipScheduleWaits={false}
          onClose={() => {
            closed = true
          }}
        />,
      ),
    )
  const input = (name: string) => {
    const field = container.querySelector(`input[name="${name}"]`)
    if (!(field instanceof HTMLInputElement)) throw new Error(`Missing ${name}`)
    return field
  }
  const fill = (name: string, value: string) =>
    act(async () => {
      const field = input(name)
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(field, value)
      field.dispatchEvent(new window.InputEvent("input", { bubbles: true }))
    })
  try {
    await render()
    const button = (text: string) => {
      const button = Array.from(container.querySelectorAll("button")).find(
        (b) => b.textContent === text,
      )
      if (!button) throw new Error(`Missing ${text} button`)
      return button
    }
    expect([...collection.values()]).toEqual([])
    expect(input("item").value).toBe("  Chair  ")
    await fill("item", "Superseded")
    await fill("item", "  Table  ")
    expect([...collection.values()]).toEqual([])
    await act(async () => root.unmount())
    root = createRoot(container)
    const drafts = [...collection.values()]
    expect(drafts).toHaveLength(1)
    expect(drafts[0]).toMatchObject({
      state: { item: "  Table  ", value: "-2" },
      totalFields: 2,
      startStepPath: "/purchase/Start",
    })
    expect(window.localStorage.getItem(draftKey)).toBeNull()
    expect(closed).toBe(false)
    await render()
    await fill("item", "Latest")
    await act(async () => root.unmount())
    expect([...collection.values()]).toEqual([
      expect.objectContaining({
        id: drafts[0]!.id,
        state: { item: "Latest", value: "-2" },
      }),
    ])
    root = createRoot(container)
    await render()
    expect(input("item").value).toBe("Latest")
    await fill("item", "Discard this unsaved change")
    await act(async () => button("Discard").click())
    expect(window.localStorage.getItem(draftKey)).toBeNull()
    expect([...collection.values()]).toEqual([])
    expect(closed).toBe(true)
    await act(async () => root.unmount())
    root = createRoot(container)
    await render()
    expect(input("item").value).toBe("")
  } finally {
    await act(async () => root.unmount())
    await collection.cleanup()
    cleanup()
  }
})

test("a fully hidden executable start still supplies its declared GraphQL input", async () => {
  const cleanup = installDom()
  const { createRoot } = await import("react-dom/client")
  const container = document.getElementById("root")!
  const root = createRoot(container)
  const hidden = withFormRules(
    Schema.Struct({
      item: Schema.optional(Schema.String),
    }),
    () => ({ item: { hidden: true } }),
  )
  // The generated start API keeps a required input object even when all fields are optional.
  const api =
    buildSchema(`type Query { ok: Boolean } input HiddenInput { item: String }
    type Started { executionId: String processId: String processPath: String timestamp: String }
    type Mutation { startHidden(input: HiddenInput!, withoutWaiting: Boolean!): Started }`)
  let received: unknown
  request = async (source, variableValues) => {
    const result = await graphql({
      schema: api,
      source,
      variableValues,
      rootValue: {
        startHidden: ({ input }: { input: unknown }) => {
          received = input
          return {}
        },
      },
    })
    expect(result.errors).toBeUndefined()
    return result.data ?? {}
  }
  const previous = schemaPromise
  // Loader exposes the shared BrowserFormSchema contract, independent of a specific fixture's keys.
  schemaPromise = Promise.resolve(hidden)
  try {
    await act(async () =>
      root.render(
        <StartProcessForm
          processId="hidden"
          processName="Hidden"
          startStepPath="/hidden/Start"
          mutationName="startHidden"
          inputTypeName="HiddenInput"
          defaultValues={{ item: "retained draft" }}
          totalFields={1}
          canSkipScheduleWaits={false}
          onClose={() => {}}
        />,
      ),
    )
    await act(async () => {
      container
        .querySelector("form")
        ?.dispatchEvent(
          new window.Event("submit", { bubbles: true, cancelable: true }),
        )
    })
    expect(received).toEqual({})
  } finally {
    schemaPromise = previous
    await act(async () => root.unmount())
    cleanup()
  }
})
