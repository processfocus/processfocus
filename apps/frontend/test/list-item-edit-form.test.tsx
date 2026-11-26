import { JSDOM } from "jsdom"
import { act } from "react"
import type { Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

vi.mock("../lib/organisation-form-loaders", async () => {
  const { Schema } = await import("effect")
  const schema = Schema.Struct({
    name: Schema.String.check(
      Schema.isMinLength(1, { message: "Name is required" }),
    ).annotate({ title: "Name" }),
  })
  return {
    organisationFormLoaders: {
      "/employees/edit": async () => schema,
      "/records/edit": async () => Schema.Struct({}),
    },
  }
})

const graphqlClient = { request: vi.fn() }

vi.mock("../lib/graphql/client-provider", () => ({
  useGraphqlClient: () => graphqlClient,
}))

describe("ListItemEditForm", () => {
  let cleanupDom: (() => void) | undefined
  let container: HTMLDivElement
  let root: Root

  beforeEach(async () => {
    cleanupDom = installDom()
    container = document.createElement("div")
    document.body.appendChild(container)
    const { createRoot } = await import("react-dom/client")
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    // Radix restores focus in a deferred callback; keep its DOM realm alive.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    cleanupDom?.()
    vi.clearAllMocks()
  })

  test("renders, validates, and submits an item through the executable definition", async () => {
    const { ListItemEditForm } = await import(
      "../app/(protected)/lists/components/list-item-edit-form"
    )
    const onClose = vi.fn()
    const onSaved = vi.fn()
    graphqlClient.request.mockResolvedValue({
      updateEmployees: { id: "employee-1", name: "Ada Lovelace" },
    })

    await act(async () => {
      root.render(
        <ListItemEditForm
          itemId="employee-1"
          listName="Employees"
          listPath="/employees"
          updateMutationName="updateEmployees"
          updateInputTypeName="UpdateEmployeesInput"
          deleteMutationName={null}
          defaultValues={{ name: "Grace Hopper" }}
          outputFields={["id", "name"]}
          onClose={onClose}
          onSaved={onSaved}
        />,
      )
    })

    const input = container.querySelector('input[name="name"]')
    const form = container.querySelector("form")
    if (
      !(input instanceof HTMLInputElement) ||
      !(form instanceof HTMLFormElement)
    ) {
      throw new Error(
        "Expected the executable list form to render a name input",
      )
    }
    expect(container.textContent).toContain("Name")
    expect(container.textContent).toContain("Save")
    expect(input.value).toBe("Grace Hopper")

    await changeTextInput(input, "")

    await submit(form)

    expect(graphqlClient.request).not.toHaveBeenCalled()
    expect(container.textContent).toContain("required")

    await changeTextInput(input, "Ada Lovelace")
    await submit(form)

    expect(graphqlClient.request).toHaveBeenCalledWith(
      expect.stringContaining("updateEmployees"),
      {
        id: "employee-1",
        input: { name: "Ada Lovelace" },
      },
    )
    expect(onSaved).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })

  test("delete confirmation keeps its accessible description without nested paragraphs", async () => {
    const { ListItemEditForm } = await import(
      "../app/(protected)/lists/components/list-item-edit-form"
    )
    await act(async () => {
      root.render(
        <ListItemEditForm
          itemId="record-1"
          listName="Records"
          listPath="/records"
          updateMutationName={null}
          updateInputTypeName={null}
          deleteMutationName="deleteListItemRecords"
          defaultValues={null}
          outputFields={[]}
          onClose={() => undefined}
        />,
      )
    })
    await act(async () => {
      container.querySelector<HTMLButtonElement>("button")?.click()
    })
    const dialog = document.querySelector('[role="dialog"]')
    const descriptionId = dialog?.getAttribute("aria-describedby")
    if (!descriptionId)
      throw new Error("Expected an accessible dialog description")
    const description = document.getElementById(descriptionId)
    expect(description?.textContent).toContain(
      "Delete item record-1 from Records?",
    )
    expect(description?.textContent).toContain("This action cannot be undone.")
    expect(dialog?.querySelector("p p") === null).toBe(true)
  })
})

const submit = async (form: HTMLFormElement): Promise<void> => {
  await act(async () => {
    form.dispatchEvent(
      new window.Event("submit", { bubbles: true, cancelable: true }),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const setNativeInputValue = (input: HTMLInputElement, value: string): void => {
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set
  if (!valueSetter) throw new Error("Expected an HTML input value setter")
  valueSetter.call(input, value)
}

const changeTextInput = async (
  input: HTMLInputElement,
  value: string,
): Promise<void> => {
  await act(async () => {
    setNativeInputValue(input, value)
    input.dispatchEvent(new window.Event("input", { bubbles: true }))

    const propertyChangeEvent = new window.Event("propertychange", {
      bubbles: true,
    })
    Object.defineProperty(propertyChangeEvent, "propertyName", {
      value: "value",
    })
    input.dispatchEvent(propertyChangeEvent)
  })
}

const installDom = (): (() => void) => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://dashboard.example.com/lists/item/employee-1",
  })
  const previousGlobals = {
    document: globalThis.document,
    Element: globalThis.Element,
    Event: globalThis.Event,
    HTMLElement: globalThis.HTMLElement,
    HTMLFormElement: globalThis.HTMLFormElement,
    HTMLInputElement: globalThis.HTMLInputElement,
    CustomEvent: globalThis.CustomEvent,
    MutationObserver: globalThis.MutationObserver,
    getComputedStyle: globalThis.getComputedStyle,
    navigator: globalThis.navigator,
    Node: globalThis.Node,
    NodeFilter: globalThis.NodeFilter,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    window: globalThis.window,
  }
  const previousActEnvironment = {
    hasValue: "IS_REACT_ACT_ENVIRONMENT" in globalThis,
    value: globalThis.IS_REACT_ACT_ENVIRONMENT,
  }

  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => undefined,
  })
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    attachEvent: {
      configurable: true,
      value(this: HTMLElement, name: string, listener: EventListener) {
        this.addEventListener(name.replace(/^on/, ""), listener)
      },
    },
    detachEvent: {
      configurable: true,
      value(this: HTMLElement, name: string, listener: EventListener) {
        this.removeEventListener(name.replace(/^on/, ""), listener)
      },
    },
  })

  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    document: dom.window.document,
    Element: dom.window.Element,
    Event: dom.window.Event,
    HTMLElement: dom.window.HTMLElement,
    HTMLFormElement: dom.window.HTMLFormElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    CustomEvent: dom.window.CustomEvent,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    navigator: dom.window.navigator,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0)
      return 0
    },
    cancelAnimationFrame: () => undefined,
    window: dom.window,
  })

  return () => {
    dom.window.close()
    Object.assign(globalThis, previousGlobals)
    if (previousActEnvironment.hasValue) {
      globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment.value
    } else {
      delete globalThis.IS_REACT_ACT_ENVIRONMENT
    }
  }
}
