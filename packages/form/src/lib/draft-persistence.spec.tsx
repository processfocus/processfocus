import { JSDOM } from "jsdom"
import { act } from "react"
import { type Root, createRoot } from "react-dom/client"
import { parseClientFormDefinition } from "@pf/form-client-representation/client-form-definition"
import { type FormProperties, dynamicForm } from "./client-components-to-form"
import { afterEach, beforeEach, expect, mock, test } from "bun:test"

const draftId = "process-start-draft-key-request/Request"
const formDefinition = parseClientFormDefinition({
  components: {
    requestedFor: {
      _tag: "select",
      field: "requestedFor",
      label: "Requested for",
      options: ["Alice", "Bob"],
    },
  },
  rules: [],
})
let dom: JSDOM
let root: Root
let container: HTMLDivElement
let restoreGlobals: () => void

beforeEach(() => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://dashboard.example/processes/start/key-request/Request",
    pretendToBeVisual: true,
  })
  // JSDOM has no layout/scroll implementation.
  dom.window.HTMLElement.prototype.scrollIntoView = () => {}
  const globals = {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  const previous = Object.keys(globals).map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  )
  Object.assign(globalThis, globals)
  restoreGlobals = () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  dom.window.close()
  restoreGlobals()
})

const renderForm = async (
  handleSubmit: FormProperties["handleSubmit"] = async () => undefined,
  required = false,
  renderActions: FormProperties["renderActions"] = () => (
    <button type="submit">Submit</button>
  ),
) => {
  await act(async () => {
    root.render(
      dynamicForm({
        draftId,
        formDefinition,
        defaultValues: {},
        jsonSchema: {
          type: "object",
          properties: { requestedFor: { type: "string", minLength: 1 } },
          ...(required ? { required: ["requestedFor"] } : {}),
        },
        handleSubmit,
        renderActions,
        onChangeDebounceMs: 0,
      }),
    )
  })
}

const changeField = async (value: string) => {
  const select = container.querySelector("select")
  if (!select) throw new Error("Missing requestedFor select")
  await act(async () => {
    select.value = value
    select.dispatchEvent(new dom.window.Event("change", { bubbles: true }))
  })
}
const submit = async () => {
  await act(async () => {
    container
      .querySelector("form")
      ?.dispatchEvent(
        new dom.window.Event("submit", { bubbles: true, cancelable: true }),
      )
  })
}
const waitForPersistence = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

test("successful submission cannot restore the stable start draft after debounce", async () => {
  const handleSubmit = mock(async () => undefined)
  await renderForm(handleSubmit)
  await changeField("0")
  await submit()
  expect(handleSubmit).toHaveBeenCalledWith({ requestedFor: "Alice" })
  expect(dom.window.localStorage.getItem(draftId)).toBeNull()
  await waitForPersistence()
  expect(dom.window.localStorage.getItem(draftId)).toBeNull()
  // A subsequent event while navigation is pending must not revive the draft.
  await changeField("1")
  await waitForPersistence()
  expect(dom.window.localStorage.getItem(draftId)).toBeNull()
})

test("unsent values survive leaving and reopening the form", async () => {
  await renderForm()
  await changeField("0")
  await waitForPersistence()
  expect(
    JSON.parse(dom.window.localStorage.getItem(draftId) ?? "null"),
  ).toEqual({ requestedFor: "Alice" })
  await act(async () => root.unmount())
  root = createRoot(container)
  await renderForm()
  expect(container.querySelector("select")?.value).toBe("0")
})

test("server errors retain the draft and allow a corrected submission", async () => {
  const handleSubmit = mock<FormProperties["handleSubmit"]>(async () => [
    { field: "", message: "Try again" },
  ])
  await renderForm(handleSubmit)
  await changeField("0")
  await submit()
  await waitForPersistence()
  expect(container.textContent).toContain("Try again")
  expect(
    JSON.parse(dom.window.localStorage.getItem(draftId) ?? "null"),
  ).toEqual({ requestedFor: "Alice" })
  handleSubmit.mockImplementation(async () => undefined)
  await changeField("1")
  await submit()
  await waitForPersistence()
  expect(dom.window.localStorage.getItem(draftId)).toBeNull()
})

test("client validation errors retain edits for correction", async () => {
  const handleSubmit = mock(async () => undefined)
  await renderForm(handleSubmit, true)
  await changeField("0")
  await changeField("")
  await submit()
  expect(handleSubmit).not.toHaveBeenCalled()
  await waitForPersistence()
  expect(dom.window.localStorage.getItem(draftId)).not.toBeNull()
  await changeField("1")
  await submit()
  expect(handleSubmit).toHaveBeenCalledWith({ requestedFor: "Bob" })
  await waitForPersistence()
  expect(dom.window.localStorage.getItem(draftId)).toBeNull()
})

test("successful submission followed by unmount leaves a blank new start", async () => {
  await renderForm()
  await changeField("0")
  await submit()
  await act(async () => root.unmount())
  await waitForPersistence()
  expect(dom.window.localStorage.getItem(draftId)).toBeNull()
  root = createRoot(container)
  await renderForm()
  expect(container.querySelector("select")?.value).toBe("")
})

test("saving a draft exposes current values and keeps later edits persistent", async () => {
  const savedValues = mock((_values: Record<string, unknown>) => {})
  await renderForm(
    async () => undefined,
    false,
    (context) => (
      <button
        type="button"
        onClick={() => {
          savedValues(context.formState.values)
          context.clearLocalStorage()
        }}
      >
        Save draft
      </button>
    ),
  )
  await changeField("0")
  await act(async () => container.querySelector("button")?.click())
  expect(savedValues).toHaveBeenCalledWith({ requestedFor: "Alice" })
  await changeField("1")
  await waitForPersistence()
  expect(
    JSON.parse(dom.window.localStorage.getItem(draftId) ?? "null"),
  ).toEqual({ requestedFor: "Bob" })
})
