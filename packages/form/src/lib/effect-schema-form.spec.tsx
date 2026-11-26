import { Schema } from "effect"
import { JSDOM } from "jsdom"
import { act } from "react"
import type { Root } from "react-dom/client"
import {
  CalendarSlotField,
  CheckboxGroupField,
  DateField,
  FormAutoFocus,
  FormComponentPluginType,
  FormLabel,
  FormLookupInput,
  FormReadOnly,
  ListField,
  LocalDateTimeField,
  LookupField,
  NumberFieldFrom,
  RadioField,
  ReadOnly,
  SuggestionField,
  TextArea,
  TextBlock,
  TextFieldFrom,
  Wrapper,
} from "@pf/form-schema"
import { withFormRules } from "@pf/form-submission-schema"
import type { EffectSchemaForm as EffectSchemaFormComponent } from "./effect-schema-form"
import { type CalendarSlotItem, LookupProvider } from "./lookup-context"
import { registerRendererPlugin } from "./plugin-registry"
import { afterEach, beforeEach, expect, test } from "bun:test"

let EffectSchemaForm: typeof EffectSchemaFormComponent
let dom: JSDOM
let root: Root
let container: HTMLDivElement
let restoreGlobals: () => void
let submissions: Record<string, unknown>[]
let intersections: ((visible: boolean) => void)[]

beforeEach(async () => {
  intersections = []
  dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://dashboard.example/lists/records",
    pretendToBeVisual: true,
  })
  dom.window.HTMLElement.prototype.scrollIntoView = () => {}
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    attachEvent: {
      value(this: HTMLElement, name: string, listener: EventListener) {
        this.addEventListener(name.replace(/^on/, ""), listener)
      },
    },
    detachEvent: {
      value(this: HTMLElement, name: string, listener: EventListener) {
        this.removeEventListener(name.replace(/^on/, ""), listener)
      },
    },
  })
  const globals = {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    Node: dom.window.Node,
    Element: dom.window.Element,
    NodeFilter: dom.window.NodeFilter,
    DocumentFragment: dom.window.DocumentFragment,
    CustomEvent: dom.window.CustomEvent,
    Event: dom.window.Event,
    MutationObserver: dom.window.MutationObserver,
    IntersectionObserver: class {
      constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
        intersections.push((isIntersecting) => callback([{ isIntersecting }]))
      }
      observe() {}
      disconnect() {}
    },
    getComputedStyle: dom.window.getComputedStyle,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  const previous = Object.keys(globals).map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  )
  Object.assign(globalThis, globals)
  ;({ EffectSchemaForm } = await import("./effect-schema-form"))
  restoreGlobals = () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
  container = document.createElement("div")
  document.body.append(container)
  const { createRoot } = await import("react-dom/client")
  root = createRoot(container)
  submissions = []
})

afterEach(async () => {
  await act(async () => root.unmount())
  dom.window.close()
  restoreGlobals()
})

const draftId = "process-start-draft-/purchase/Submit"

test.each([
  ["", false],
  [false, false],
  [true, true],
] as const)(
  "submits a restored checkbox draft with value %p",
  async (invoiced, expected) => {
    dom.window.localStorage.setItem(
      draftId,
      JSON.stringify({ child: "student-id", invoiced }),
    )
    await act(async () =>
      root.render(
        <EffectSchemaForm
          schema={Schema.Struct({
            child: Schema.String,
            invoiced: Schema.optional(Schema.Boolean),
          })}
          draftId={draftId}
          defaultValues={{ child: "", invoiced: false }}
          onSubmit={async (values) => {
            submissions.push(values)
          }}
        >
          {() => <button type="submit">Submit</button>}
        </EffectSchemaForm>,
      ),
    )
    expect(input("invoiced").checked).toBe(expected)
    await submit()
    expect(submissions).toEqual([{ child: "student-id", invoiced: expected }])
  },
)

test("checkbox groups stay locked until prefill completes", async () => {
  const deferred = Promise.withResolvers<Record<string, unknown>>()
  await act(async () =>
    root.render(
      <LookupProvider
        value={{
          fetchSuggestions: async () => [],
          fetchDependentSuggestions: async () => [],
          fetchCalendarSlots: async () => [],
          fetchPrefill: () => deferred.promise,
        }}
      >
        <EffectSchemaForm
          schema={Schema.Struct({
            record: Schema.String,
            ids: CheckboxGroupField({
              options: [{ value: "a", label: "Alpha" }],
            }),
          })}
          defaultValues={{ record: "one", ids: [] }}
          requestData={{
            originalValues: {},
            inaccessible: [],
            presentation: {},
            prefill: {
              dependency: "record",
              fields: ["ids"],
              concealed: [],
              queryName: "load",
            },
          }}
          onSubmit={async (values) => {
            submissions.push(values)
          }}
        >
          {() => <button type="submit">Save</button>}
        </EffectSchemaForm>
      </LookupProvider>,
    ),
  )
  expect(input("ids").matches(":disabled")).toBe(true)
  await act(async () => input("ids").click())
  expect(input("ids").checked).toBe(false)
  await act(async () => deferred.resolve({ ids: ["a"] }))
  expect(input("ids").matches(":disabled")).toBe(false)
  expect(input("ids").checked).toBe(true)
  await act(async () => input("ids").click())
  await submit()
  expect(submissions).toEqual([{ record: "one", ids: [] }])
})

test("checkbox groups retain unavailable selections, report rejection, and allow explicit empty selection", async () => {
  const schema = Schema.Struct({
    ids: CheckboxGroupField({
      label: "Access",
      description: "Choose access",
      options: [{ value: "a", label: "Alpha", description: "/alpha" }],
    }),
  })
  let reject = true
  await act(async () =>
    root.render(
      <EffectSchemaForm
        schema={schema}
        defaultValues={{ ids: ["a", "missing"] }}
        onSubmit={async (values) => {
          submissions.push(values)
          return reject
            ? [{ field: "ids", message: "Access denied" }]
            : undefined
        }}
      >
        {() => <button type="submit">Save</button>}
      </EffectSchemaForm>,
    ),
  )
  expect(container.textContent).toContain("/alpha")
  expect(container.textContent).toContain("missing (unavailable)")
  await submit()
  expect(submissions).toEqual([{ ids: ["a", "missing"] }])
  expect(container.textContent).toContain("Access denied")
  expect(document.activeElement).toBe(input("ids"))
  reject = false
  const checkboxes = container.querySelectorAll<HTMLInputElement>(
    'input[type="checkbox"]',
  )
  await act(async () => checkboxes[0]?.click())
  await submit()
  expect(submissions.at(-1)).toEqual({ ids: ["missing"] })
  await act(async () => checkboxes[1]?.click())
  await submit()
  expect(submissions.at(-1)).toEqual({ ids: [] })
})

test("non-persistent forms never access storage and remount with current defaults", async () => {
  const storage = dom.window.Storage.prototype
  const originals = [
    storage.getItem,
    storage.setItem,
    storage.removeItem,
  ] as const
  const accesses: string[] = []
  storage.getItem = (key) => {
    accesses.push(key)
    return '{"note":"stale draft"}'
  }
  storage.setItem = (key) => {
    accesses.push(key)
  }
  storage.removeItem = (key) => {
    accesses.push(key)
  }
  const render = async (identity: string, note: string) =>
    act(async () =>
      root.render(
        <EffectSchemaForm
          key={identity}
          schema={Schema.Struct({ note: Schema.String })}
          defaultValues={{ note }}
          onSubmit={async (values) => {
            submissions.push(values)
          }}
        >
          {() => <button type="submit">Save</button>}
        </EffectSchemaForm>,
      ),
    )
  try {
    await render("one", "fresh")
    expect(input("note").value).toBe("fresh")
    await edit("note", "edited")
    await render("one", "background refetch")
    expect(input("note").value).toBe("edited")
    await submit()
    expect(submissions).toEqual([{ note: "edited" }])
    await render("two", "second user")
    expect(input("note").value).toBe("second user")
    await render("one", "persisted")
    expect(input("note").value).toBe("persisted")
    expect(accesses).toEqual([])
  } finally {
    ;[storage.getItem, storage.setItem, storage.removeItem] = originals
  }
})

test("checkbox groups enforce shared checks and keep read-only selections out of submission", async () => {
  const choice = CheckboxGroupField({
    label: "Choices",
    options: [{ value: "one", label: "One" }],
  })
  const schema = Schema.Struct({
    ids: choice.check(
      Schema.makeFilter((values) => values.length > 0 || "Choose at least one"),
    ),
    locked: ReadOnly(choice),
  })
  await act(async () =>
    root.render(
      <EffectSchemaForm
        schema={schema}
        defaultValues={{ ids: [], locked: ["one"] }}
        onSubmit={async (values) => {
          submissions.push(values)
        }}
      >
        {() => <button type="submit">Save</button>}
      </EffectSchemaForm>,
    ),
  )
  expect(input("locked").matches(":disabled")).toBe(true)
  expect(input("locked").checked).toBe(true)
  await submit()
  expect(submissions).toEqual([])
  expect(container.textContent).toContain("Choose at least one")
  expect(document.activeElement).toBe(input("ids"))
  await act(async () => input("ids").click())
  await submit()
  expect(submissions).toEqual([{ ids: ["one"] }])
})

test.each(["unconfigured", "legacy"] as const)(
  "%s lookup requires an explicit selection while suggestions accept text",
  async (kind) => {
    const choice =
      kind === "legacy"
        ? Schema.String.annotate({
            [FormLookupInput]: {},
            [FormLabel]: "Choice",
          })
        : LookupField({ label: "Choice" })
    await act(async () =>
      root.render(
        <LookupProvider
          value={{
            fetchSuggestions: async () => [
              { value: "project-id", label: "Project name" },
            ],
            fetchDependentSuggestions: async () => [],
            fetchCalendarSlots: async () => [],
          }}
        >
          <EffectSchemaForm
            schema={Schema.Struct({
              choice: Schema.optional(choice),
              suggestion: SuggestionField({ label: "Suggestion" }),
            })}
            stepPath="/fixture/Start"
            draftId={`single-input-${kind}`}
            defaultValues={{ suggestion: "" }}
            onSubmit={async (values) => {
              submissions.push(values)
            }}
          >
            {() => <button type="submit">Submit</button>}
          </EffectSchemaForm>
        </LookupProvider>,
      ),
    )
    const key = (name: string, key: string) =>
      act(async () => {
        input(name).dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            key,
            bubbles: true,
            cancelable: true,
          }),
        )
      })
    await act(async () => input("choice").focus())
    expect(input("choice").getAttribute("role")).toBe("combobox")
    expect(document.querySelector('button[role="combobox"]')).toBeNull()
    await edit("choice", "Project")
    await act(async () => new Promise((resolve) => setTimeout(resolve, 320)))
    const list = document.getElementById(
      input("choice").getAttribute("aria-controls")!,
    )
    expect(list?.getAttribute("role")).toBe("listbox")
    // Suggestions are portaled outside the form's potentially clipped container.
    expect(container.contains(list)).toBe(false)
    // Clicking popup padding must keep typing focus, rather than dismissing it.
    const popup = list?.closest('[role="presentation"]')
    const mouseDown = new dom.window.MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    })
    await act(async () => {
      popup?.dispatchEvent(mouseDown)
    })
    expect(mouseDown.defaultPrevented).toBe(true)
    await key("choice", "Tab")
    await submit()
    expect(submissions).toHaveLength(0)
    expect(document.body.textContent).toContain(
      "Select an option from the suggestions.",
    )
    await key("choice", "ArrowDown")
    await act(async () => new Promise((resolve) => setTimeout(resolve, 320)))
    await key("choice", "ArrowDown")
    expect(
      document.getElementById(
        input("choice").getAttribute("aria-activedescendant")!,
      )?.textContent,
    ).toBe("Project name")
    await key("choice", "Enter")
    expect(input("choice").value).toBe("Project name")
    await edit("suggestion", "A custom value")
    await key("suggestion", "Escape")
    await submit()
    expect(submissions).toEqual([
      { choice: "project-id", suggestion: "A custom value" },
    ])
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('button[aria-label="Clear Choice"]')!
        .click(),
    )
    await submit()
    expect(submissions[1]).toEqual({ suggestion: "A custom value" })
  },
)

const schema = Schema.Struct({
  request: Wrapper({
    item: TextFieldFrom(Schema.Trim.check(Schema.isMinLength(1))),
    value: NumberFieldFrom(
      Schema.NumberFromString.check(Schema.isGreaterThan(0)),
    ),
  }),
})

const renderForm = async (reject = false, formSchema = schema) => {
  await act(async () =>
    root.render(
      <EffectSchemaForm
        schema={formSchema}
        draftId={draftId}
        defaultValues={{ item: "", value: "" }}
        onSubmit={async (values) => {
          submissions.push(values)
          return reject
            ? [{ field: "item", message: "Already purchased" }]
            : undefined
        }}
      >
        {() => <button type="submit">Submit</button>}
      </EffectSchemaForm>,
    ),
  )
}

const input = (name: string) => {
  const element = container.querySelector(`input[name="${name}"]`)
  if (!(element instanceof dom.window.HTMLInputElement))
    throw new Error("Missing input")
  return element
}
const edit = async (name: string, value: string) => {
  await act(async () => {
    const element = input(name)
    element.focus()
    const setter = Object.getOwnPropertyDescriptor(
      dom.window.HTMLInputElement.prototype,
      "value",
    )?.set
    if (!setter) throw new Error("Missing native input setter")
    setter.call(element, value)
    element.dispatchEvent(new dom.window.Event("input", { bubbles: true }))
    const event = new dom.window.Event("propertychange", { bubbles: true })
    Object.defineProperty(event, "propertyName", { value: "value" })
    element.dispatchEvent(event)
  })
}
const submit = async () => {
  await act(async () => {
    container.querySelector("button")?.focus()
    container
      .querySelector("form")
      ?.dispatchEvent(
        new dom.window.Event("submit", { bubbles: true, cancelable: true }),
      )
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
}

test("local choices wait for visibility, filter the complete dataset and retain choices on rejected-submit refresh failure", async () => {
  const requests: {
    resolve: (
      items: { value: string; label: string; searchText?: string }[],
    ) => void
    reject: () => void
  }[] = []
  const options = () =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]'))
  const retry = async () =>
    act(async () =>
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Retry")
        ?.click(),
    )
  await act(async () =>
    root.render(
      <LookupProvider
        value={{
          fetchSuggestions: async (_step, _field, filter, limit) => {
            expect(filter).toBe("")
            expect(limit).toBe(26)
            return new Promise((resolve, reject) =>
              requests.push({
                resolve,
                reject: () => reject(new Error("offline")),
              }),
            )
          },
          fetchDependentSuggestions: async () => [],
          fetchCalendarSlots: async () => [],
        }}
      >
        <EffectSchemaForm
          schema={Schema.Struct({
            note: Schema.String,
            choice: LookupField({
              mode: "local",
              maxItems: 25,
              label: "Choice",
            }),
          })}
          stepPath="/local/Submit"
          draftId="local-contract"
          defaultValues={{ note: "", choice: "" }}
          onSubmit={async (values) => {
            submissions.push(values)
            return [{ field: "choice", message: "No longer eligible" }]
          }}
        >
          {() => <button type="submit">Submit</button>}
        </EffectSchemaForm>
      </LookupProvider>,
    ),
  )
  await edit("note", "Keep my note")
  await edit("choice", "year 4")
  expect(requests).toHaveLength(0)
  await act(async () => {
    for (const notify of intersections) notify(false)
  })
  expect(requests).toHaveLength(0)
  await act(async () => {
    for (const notify of intersections) notify(true)
  })
  expect(requests).toHaveLength(1)
  await act(async () => {
    for (const notify of intersections) notify(false)
  })
  await act(async () => requests[0]!.reject())
  expect(document.body.textContent).toContain("Couldn't load choices")
  await act(async () => {
    for (const notify of intersections) notify(true)
  })
  expect(requests).toHaveLength(1)
  await retry()
  const dataset = Array.from({ length: 25 }, (_, i) => ({
    value: `id-${i}`,
    label: `Chloé ${i} (Year 4)`,
    searchText: i === 24 ? "eldest" : "",
  }))
  await act(async () => {
    for (const notify of intersections) notify(false)
  })
  await act(async () => requests[1]!.resolve(dataset))
  await act(async () => {
    for (const notify of intersections) notify(true)
  })
  expect(requests).toHaveLength(2)
  expect(options()).toHaveLength(25)
  await edit("choice", "4 CHLOE eldest")
  expect(options().map((option) => option.textContent)).toEqual([
    "Chloé 24 (Year 4)",
  ])
  expect(requests).toHaveLength(2)
  await act(async () => options()[0]!.click())
  await submit()
  expect(submissions).toEqual([{ note: "Keep my note", choice: "id-24" }])
  expect(requests).toHaveLength(3)
  await act(async () => requests[2]!.reject())
  await edit("choice", "Chloe")
  expect(options()).toHaveLength(25)
  expect(options().every((option) => !option.disabled)).toBe(true)
  expect(input("note").value).toBe("Keep my note")
  await retry()
  await act(async () =>
    requests[3]!.resolve([
      ...dataset,
      { value: "overflow", label: "Partial choice" },
    ]),
  )
  expect(document.body.textContent).toContain("Please contact the form owner")
  expect(options()).toHaveLength(25)
  expect(container.textContent).not.toContain("Partial choice")
})

test("local choices reload when a cleared dependency is restored", async () => {
  const requests: Record<string, unknown>[] = []
  await act(async () =>
    root.render(
      <LookupProvider
        value={{
          fetchSuggestions: async () => [],
          fetchDependentSuggestions: async (_query, variables) => {
            requests.push(variables)
            return [{ value: "child-1", label: "Alice" }]
          },
          fetchCalendarSlots: async () => [],
        }}
      >
        <EffectSchemaForm
          schema={Schema.Struct({
            parent: Schema.String,
            choice: LookupField({ mode: "local", maxItems: 5 }),
          })}
          requestData={{
            presentation: {},
            inaccessible: [],
            originalValues: {},
            lookups: {
              choice: { queryName: "children", dependencies: ["parent"] },
            },
          }}
          stepPath="/dependent/Submit"
          draftId="dependent-local-contract"
          defaultValues={{ parent: "A", choice: "" }}
          onSubmit={async (values) => {
            submissions.push(values)
            return undefined
          }}
        >
          {() => <button type="submit">Submit</button>}
        </EffectSchemaForm>
      </LookupProvider>,
    ),
  )
  await act(async () => {
    for (const notify of intersections) notify(true)
    input("choice").focus()
  })
  const option = () =>
    document.querySelector<HTMLButtonElement>('[role="option"]')
  expect(option()?.textContent).toBe("Alice")
  await act(async () => option()?.click())
  await edit("parent", "")
  expect(input("choice").disabled).toBe(true)
  expect(input("choice").value).toBe("")
  expect(requests).toHaveLength(1)
  await edit("parent", "A")
  expect(requests).toHaveLength(1)
  await act(async () => {
    for (const notify of intersections) notify(true)
  })
  await act(async () => input("choice").focus())
  expect(option()?.textContent).toBe("Alice")
  expect(requests).toHaveLength(2)
  await act(async () => option()?.click())
  await submit()
  expect(submissions).toEqual([{ parent: "A", choice: "child-1" }])
})

test.each(["local", "server"] as const)(
  "dependent %s choices discard obsolete responses and identities",
  async (mode) => {
    const requests: {
      variables: Record<string, unknown>
      resolve: (items: { value: string; label: string }[]) => void
    }[] = []
    const pause = async () =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 280))
      })
    const visible = async () =>
      act(async () => {
        for (const notify of intersections) notify(true)
      })
    const focus = async () => {
      await act(async () => input("choice").focus())
      await pause()
    }
    const option = () =>
      document.querySelector<HTMLButtonElement>('[role="option"]')
    await act(async () =>
      root.render(
        <LookupProvider
          value={{
            fetchSuggestions: async () => {
              throw new Error("Wrong transport")
            },
            search: async () => {
              throw new Error("Missing dependencies")
            },
            fetchDependentSuggestions: async (_query, variables) =>
              new Promise((resolve) => requests.push({ variables, resolve })),
            fetchCalendarSlots: async () => [],
          }}
        >
          <EffectSchemaForm
            schema={Schema.Struct({
              parent: Schema.String,
              choice:
                mode === "local"
                  ? LookupField({ mode, maxItems: 25 })
                  : LookupField({ mode }),
            })}
            requestData={{
              presentation: {},
              inaccessible: [],
              originalValues: {},
              lookups: {
                choice: { queryName: "children", dependencies: ["parent"] },
              },
            }}
            stepPath="/dependent/Submit"
            draftId={`dependent-${mode}-race`}
            defaultValues={{ parent: "", choice: "" }}
            onSubmit={async (values) => {
              submissions.push(values)
            }}
          >
            {() => <button type="submit">Submit</button>}
          </EffectSchemaForm>
        </LookupProvider>,
      ),
    )
    expect(input("choice").disabled).toBe(true)
    await visible()
    expect(requests).toHaveLength(0)
    await edit("parent", "A")
    await pause()
    expect(requests).toHaveLength(0)
    if (mode === "local") await visible()
    await focus()
    expect(requests).toHaveLength(1)
    await act(async () =>
      requests[0]!.resolve([{ value: "a", label: "Alice" }]),
    )
    await act(async () => option()?.click())
    await edit("parent", "B")
    expect(input("choice").value).toBe("")
    await submit()
    expect(submissions).toHaveLength(0)
    if (mode === "local") await visible()
    await focus()
    expect(requests).toHaveLength(2)
    await edit("choice", "old text")
    await edit("parent", "C")
    expect(input("choice").value).toBe("")
    await pause()
    expect(requests).toHaveLength(2)
    if (mode === "local") await visible()
    await focus()
    expect(requests).toHaveLength(3)
    expect(requests[2]!.variables).toEqual({
      input: { filter: "", parent: "C" },
      limit: mode === "local" ? 26 : 21,
    })
    await act(async () =>
      requests[2]!.resolve([{ value: "c", label: "Chloé" }]),
    )
    await act(async () => option()?.click())
    await act(async () =>
      requests[1]!.resolve([{ value: "b", label: "Obsolete" }]),
    )
    expect(input("choice").value).toBe("Chloé")
    expect(container.textContent).not.toContain("Obsolete")
    await submit()
    expect(submissions).toEqual([{ parent: "C", choice: "c" }])
  },
)

test("server lookup keeps typing responsive, rejects stale choices and submits only explicit selections", async () => {
  type Page = { items: { value: string; label: string }[]; hasMore: boolean }
  const requests: {
    filter: string
    resolve: (page: Page) => void
    reject: () => void
  }[] = []
  const pause = async () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 280))
    })
  const key = async (key: string) =>
    act(async () => {
      input("choice").dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key,
          bubbles: true,
          cancelable: true,
        }),
      )
    })
  const option = () =>
    document.querySelector<HTMLButtonElement>('[role="option"]')
  const choose = async () =>
    act(async () => {
      option()?.click()
    })
  await act(async () =>
    root.render(
      <LookupProvider
        value={{
          search: async (_step, _field, filter) =>
            new Promise<Page>((resolve, reject) =>
              requests.push({
                filter,
                resolve,
                reject: () => reject(new Error("offline")),
              }),
            ),
          fetchSuggestions: async () => [],
          fetchDependentSuggestions: async () => [],
          fetchCalendarSlots: async () => [],
        }}
      >
        <EffectSchemaForm
          schema={Schema.Struct({
            note: Schema.String,
            choice: Schema.optional(
              LookupField({ mode: "server", label: "Choice" }),
            ),
          })}
          stepPath="/purchase/Submit"
          draftId="server-lookup-contract"
          defaultValues={{ note: "" }}
          onSubmit={async (values) => {
            submissions.push(values)
            return undefined
          }}
        >
          {() => <button type="submit">Submit</button>}
        </EffectSchemaForm>
      </LookupProvider>,
    ),
  )
  await pause()
  expect(requests).toHaveLength(0)
  await act(async () => input("choice").focus())
  await pause()
  expect(requests[0]?.filter).toBe("")
  await act(async () =>
    requests[0]?.resolve({
      items: [{ value: "one", label: "First choice" }],
      hasMore: true,
    }),
  )
  expect(document.body.textContent).toContain("More matches—keep typing")
  await pause()
  await act(async () => {
    input("choice").dispatchEvent(
      new dom.window.MouseEvent("pointerdown", { bubbles: true, button: 0 }),
    )
    input("choice").click()
  })
  expect(input("choice").getAttribute("aria-expanded")).toBe("true")
  await choose()
  expect(input("choice").value).toBe("First choice")
  await edit("choice", "second")
  expect(input("choice").disabled).toBe(false)
  expect(option()?.textContent).toBe("First choice")
  expect(option()?.disabled).toBe(true)
  await choose()
  await key("Enter")
  expect(input("choice").value).toBe("second")
  await pause()
  const old = requests.at(-1)!
  expect(old.filter).toBe("second")
  await edit("choice", "third")
  await pause()
  const current = requests.at(-1)!
  expect(current.filter).toBe("third")
  await act(async () =>
    current.resolve({
      items: [{ value: "three", label: "Third choice" }],
      hasMore: false,
    }),
  )
  await act(async () =>
    old.resolve({
      items: [{ value: "two", label: "Obsolete choice" }],
      hasMore: false,
    }),
  )
  expect(option()?.textContent).toBe("Third choice")
  await key("Tab")
  await submit()
  expect(submissions).toEqual([])
  expect(input("choice").value).toBe("third")
  expect(container.textContent).toContain(
    "Select an option from the suggestions.",
  )
  await edit("choice", "retry")
  await pause()
  await act(async () => requests.at(-1)?.reject())
  expect(document.body.textContent).toContain("Couldn't load choices")
  await key("Tab")
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Clear Choice"]')
      ?.focus(),
  )
  expect(input("choice").getAttribute("aria-expanded")).toBe("false")
  const retry = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Retry",
  )
  expect(retry).toBeDefined()
  await act(async () => retry?.focus())
  expect(document.activeElement).toBe(retry!)
  await act(async () => retry?.click())
  expect(document.activeElement).toBe(input("choice"))
  expect(input("choice").value).toBe("retry")
  await pause()
  expect(requests.at(-1)?.filter).toBe("retry")
  await act(async () => requests.at(-1)?.resolve({ items: [], hasMore: false }))
  expect(document.body.textContent).toContain("No matches")
  await edit("choice", "final")
  await pause()
  await act(async () =>
    requests.at(-1)?.resolve({
      items: [{ value: "final-id", label: "Final label" }],
      hasMore: false,
    }),
  )
  await key("Enter")
  expect(input("choice").value).toBe("Final label")
  await edit("note", "A note")
  await submit()
  expect(submissions).toEqual([{ note: "A note", choice: "final-id" }])
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Clear Choice"]')
      ?.click(),
  )
  await submit()
  expect(submissions.at(-1)).toEqual({ note: "A note", choice: undefined })
})

test.each(["restored", "unavailable", "edited while resolving"])(
  "restored lookup identity is independent of choices: %s",
  async (scenario) => {
    let finish: (item: { value: string; label: string } | null) => void =
      () => {}
    const resolutions: string[] = []
    let searches = 0
    dom.window.localStorage.setItem(
      draftId,
      JSON.stringify({ note: "Unrelated draft edit", choice: "saved-id" }),
    )
    await act(async () =>
      root.render(
        <LookupProvider
          value={{
            resolveSelection: async (_step, _field, value) => {
              resolutions.push(value)
              return new Promise((resolve) => {
                finish = resolve
              })
            },
            search: async () => {
              searches += 1
              return {
                items: [{ value: "new-id", label: "New selection" }],
                hasMore: false,
              }
            },
            fetchSuggestions: async () => {
              throw new Error("Unexpected dataset download")
            },
            fetchDependentSuggestions: async () => [],
            fetchCalendarSlots: async () => [],
          }}
        >
          <EffectSchemaForm
            schema={Schema.Struct({
              note: Schema.String,
              choice: Schema.optional(
                LookupField({ mode: "server", label: "Choice" }),
              ),
            })}
            stepPath="/purchase/Submit"
            draftId={draftId}
            defaultValues={{ note: "" }}
            onSubmit={async (values) => {
              submissions.push(values)
            }}
          >
            {() => <button type="submit">Submit</button>}
          </EffectSchemaForm>
        </LookupProvider>,
      ),
    )
    expect(input("choice").value).toBe("")
    expect(resolutions).toEqual(["saved-id"])
    expect(searches).toBe(0)
    if (scenario === "edited while resolving") await edit("choice", "My search")
    await act(async () =>
      finish(
        scenario === "unavailable"
          ? null
          : { value: "saved-id", label: "Saved label outside search" },
      ),
    )
    if (scenario === "restored") {
      expect(input("choice").value).toBe("Saved label outside search")
      expect(searches).toBe(0)
      await submit()
      expect(submissions).toEqual([
        { note: "Unrelated draft edit", choice: "saved-id" },
      ])
    } else {
      if (scenario === "unavailable")
        expect(container.textContent).toContain("Selection unavailable")
      else expect(input("choice").value).toBe("My search")
      await submit()
      expect(submissions).toEqual([])
      await edit("choice", "New")
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 280))
      })
      await act(async () =>
        document.querySelector<HTMLButtonElement>('[role="option"]')?.click(),
      )
      expect(input("choice").value).toBe("New selection")
      await submit()
      expect(submissions).toEqual([
        { note: "Unrelated draft edit", choice: "new-id" },
      ])
    }
  },
)

test("session draft survives remount and clears only after successful raw-input submission", async () => {
  dom.window.localStorage.setItem(
    draftId,
    JSON.stringify({ item: "Saved item", value: "42" }),
  )
  await renderForm()
  expect(input("item").value).toBe("Saved item")
  await edit("item", "  New item  ")
  await edit("value", "123.")
  expect(input("value").value).toBe("123.")
  await act(async () => root.unmount())
  const { createRoot } = await import("react-dom/client")
  root = createRoot(container)
  await renderForm()
  expect(input("item").value).toBe("  New item  ")
  expect(input("value").value).toBe("123.")
  await submit()
  expect(submissions).toEqual([{ item: "  New item  ", value: "123." }])
  expect(dom.window.localStorage.getItem(draftId)).toBeNull()
})

test.each([false, true])(
  "clearing a server selection respects nullable=%s while fixed choices remain selects",
  async (nullable) => {
    const choice = LookupField({ mode: "server", label: "Choice" })
    await act(async () =>
      root.render(
        <LookupProvider
          value={{
            search: async () => ({
              items: [{ value: "id", label: "Choice label" }],
              hasMore: false,
            }),
            fetchSuggestions: async () => [],
            fetchDependentSuggestions: async () => [],
            fetchCalendarSlots: async () => [],
          }}
        >
          <EffectSchemaForm
            schema={Schema.Struct({
              choice: nullable ? Schema.NullOr(choice) : choice,
              relationship: Schema.Literals(["Parent", "Other"]),
            })}
            stepPath="/purchase/Submit"
            draftId="required-server-lookup"
            defaultValues={{ choice: "", relationship: "Parent" }}
            onSubmit={async (values) => {
              submissions.push(values)
              return undefined
            }}
          >
            {() => <button type="submit">Submit</button>}
          </EffectSchemaForm>
        </LookupProvider>,
      ),
    )
    await act(async () => input("choice").focus())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60))
    })
    expect(container.querySelector("select")?.value).toBe("Parent")
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[role="option"]')?.click(),
    )
    expect(input("choice").value).toBe("Choice label")
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Clear Choice"]')
        ?.click(),
    )
    await submit()
    expect(submissions).toEqual(
      nullable ? [{ choice: null, relationship: "Parent" }] : [],
    )
    expect(input("choice").value).toBe("")
    expect(input("choice").getAttribute("aria-invalid")).toBe(String(!nullable))
    if (!nullable)
      expect(container.textContent).toContain(
        "Select an option from the suggestions.",
      )
  },
)

test("client and server rejection focus the first invalid field and retain the draft", async () => {
  await renderForm(true)
  await submit()
  expect(submissions).toEqual([])
  expect(document.activeElement).toBe(input("item"))
  await edit("item", "Chair")
  await edit("value", "12")
  await submit()
  expect(submissions).toEqual([{ item: "Chair", value: "12" }])
  expect(container.textContent).toContain("Already purchased")
  expect(document.activeElement).toBe(input("item"))
  expect(
    JSON.parse(dom.window.localStorage.getItem(draftId) ?? "null"),
  ).toEqual({ item: "Chair", value: "12" })
})

test("validation waits for blur, hides untouched errors and revalidates after submit", async () => {
  await renderForm()
  await edit("value", "-")
  expect(input("value").getAttribute("aria-invalid")).toBe("false")
  expect(input("item").getAttribute("aria-invalid")).toBe("false")
  await act(async () => input("value").blur())
  expect(input("value").getAttribute("aria-invalid")).toBe("true")
  expect(input("item").getAttribute("aria-invalid")).toBe("false")
  await edit("value", "12.")
  expect(input("value").value).toBe("12.")
  expect(input("value").getAttribute("aria-invalid")).toBe("false")
  await submit()
  expect(submissions).toEqual([])
  expect(input("item").getAttribute("aria-invalid")).toBe("true")
  expect(document.activeElement).toBe(input("item"))
  await edit("item", "Chair")
  expect(input("item").getAttribute("aria-invalid")).toBe("false")
  await edit("value", "-")
  expect(input("value").getAttribute("aria-invalid")).toBe("true")
})

for (const alreadyFocused of [false, true]) {
  test(`initial focus ${alreadyFocused ? "preserves an active form control" : "moves to the first editable field"}`, async () => {
    await renderForm()
    if (alreadyFocused) await act(async () => input("value").focus())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60))
    })
    expect(document.activeElement).toBe(
      input(alreadyFocused ? "value" : "item"),
    )
  })
}

test("explicit autofocus opt-out preserves the review heading and still focuses validation errors", async () => {
  const heading = document.createElement("h2")
  heading.tabIndex = -1
  document.body.prepend(heading)
  heading.focus()
  await renderForm(false, schema.annotate({ [FormAutoFocus]: false }))
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60))
  })
  expect(document.activeElement).toBe(heading)
  await submit()
  expect(document.activeElement).toBe(input("item"))
})

test("executable ordered rules normalize controls, retain hidden drafts and preserve disabled defaults", async () => {
  const fields = withFormRules(
    Schema.Struct({
      status: TextFieldFrom(Schema.Trim),
      details: Schema.optional(
        TextFieldFrom(Schema.String.check(Schema.isMinLength(3))),
      ),
      section: Wrapper({
        locked: Schema.optional(TextFieldFrom(Schema.String)),
      }),
    }),
    (value) => ({
      details: {
        hidden: value.status === "hide",
        required: value.status === "show",
      },
      section: { $self: { disabled: true } },
    }),
    (value) => ({
      details: { label: value.status === "show" ? "Explain" : "Details" },
    }),
  )
  await act(async () =>
    root.render(
      <EffectSchemaForm
        schema={fields}
        draftId="rules"
        requestData={{
          presentation: {},
          inaccessible: [],
          originalValues: { locked: "original" },
        }}
        defaultValues={{ status: "show", details: "draft", locked: "original" }}
        onSubmit={async (values) => {
          submissions.push(values)
          return undefined
        }}
      >
        {() => <button type="submit">Submit</button>}
      </EffectSchemaForm>,
    ),
  )
  expect(input("locked").disabled).toBe(true)
  expect(container.textContent).toContain("Explain")
  await edit("details", "x")
  await edit("status", " hide ")
  expect(container.querySelector('[name="details"]')).toBeNull()
  await edit("status", "show")
  expect(input("details").value).toBe("x")
  await submit()
  expect(submissions).toEqual([])
  await edit("status", " hide ")
  await submit()
  expect(submissions).toEqual([{ status: " hide ", locked: "original" }])
})

test("optional disabled placeholders and cleared dates submit as absent", async () => {
  const fields = withFormRules(
    Schema.Struct({
      amount: Schema.optional(
        NumberFieldFrom(Schema.NumberFromString.check(Schema.isGreaterThan(0))),
      ),
      date: Schema.optional(DateField({ label: "Date" })),
    }),
    () => ({ amount: { disabled: true } }),
  )
  await act(async () =>
    root.render(
      <EffectSchemaForm
        schema={fields}
        draftId="optional-controls"
        defaultValues={{ amount: "", date: "2026-10-20T00:00:00.000Z" }}
        requestData={{ presentation: {}, inaccessible: [], originalValues: {} }}
        onSubmit={async (values) => {
          submissions.push(values)
        }}
      >
        {() => <button type="submit">Submit</button>}
      </EffectSchemaForm>,
    ),
  )
  await edit("date", "")
  await submit()
  expect(submissions).toHaveLength(1)
  expect(submissions[0]?.["amount"]).toBeUndefined()
  expect(submissions[0]?.["date"]).toBeUndefined()
})

// Owns untouched select errors/focus and the encoded submission boundary, including
// nested optional enums and exclusion of read-only data returned by a List query.
test("List selects focus untouched errors and preserve optional/null inputs without submitting read-only values", async () => {
  const listSchema = Schema.Struct({
    id: Schema.String.annotate({ [FormReadOnly]: true }),
    name: TextFieldFrom(Schema.Trim),
    category: Schema.Literals(["A", "B"]).annotate({ title: "Category" }),
    optional: Schema.optional(
      Schema.Literals(["A", "B"]).annotate({ title: "Optional choice" }),
    ),
    nullable: Schema.NullOr(Schema.Literals(["A", "B"])),
  })
  await act(async () =>
    root.render(
      <EffectSchemaForm
        schema={listSchema}
        draftId="list-select"
        defaultValues={{
          id: "record",
          name: "  Ada  ",
          category: "",
          optional: undefined,
          nullable: null,
        }}
        onSubmit={async (values) => {
          submissions.push(values)
          return undefined
        }}
      >
        {() => <button type="submit">Save</button>}
      </EffectSchemaForm>,
    ),
  )
  await submit()
  expect(submissions).toEqual([])
  expect(container.textContent).toContain("This field is required.")
  expect(document.activeElement?.id).toBe("category")
  expect(container.textContent).toContain("Optional choice")
  const select = container.querySelector('select[name="category"]')
  if (!(select instanceof dom.window.HTMLSelectElement))
    throw new Error("Missing category select")
  await act(async () => {
    select.value = "B"
    select.dispatchEvent(new dom.window.Event("change", { bubbles: true }))
  })
  await submit()
  expect(submissions).toEqual([
    { name: "  Ada  ", category: "B", optional: undefined, nullable: null },
  ])
})

test("calendar validity rejects a codec-normalizable impossible date", async () => {
  await act(async () =>
    root.render(
      <EffectSchemaForm
        schema={Schema.Struct({ date: DateField({ label: "Date" }) })}
        draftId="list-date"
        defaultValues={{ date: "2026-02-31T00:00:00.000Z" }}
        onSubmit={async (values) => {
          submissions.push(values)
          return undefined
        }}
      >
        {() => <button type="submit">Save</button>}
      </EffectSchemaForm>,
    ),
  )
  await submit()
  expect(submissions).toEqual([])
  expect(container.textContent).toContain("Please enter a valid date")
  expect(document.activeElement).toBe(input("date"))
})

test("local date-time fields submit calendar and time together and allow clearing an optional value", async () => {
  const schema = Schema.Struct({
    start: LocalDateTimeField({ label: "Starts at", required: true }),
    end: Schema.optional(LocalDateTimeField({ label: "Ends at" })),
  }).annotate({ [FormAutoFocus]: false })
  await act(async () =>
    root.render(
      <EffectSchemaForm
        schema={schema}
        defaultValues={{
          start: "2026-11-24 15:10:27",
          end: "2026-11-24 16:20:00",
        }}
        onSubmit={async (values) => {
          submissions.push(values)
        }}
      >
        {() => <button type="submit">Save</button>}
      </EffectSchemaForm>,
    ),
  )
  expect(input("start").value).toBe("15:10:27")
  const click = async (selector: string) => {
    const button = document.querySelector(selector)
    if (!(button instanceof dom.window.HTMLButtonElement))
      throw new Error(`Missing button: ${selector}`)
    await act(async () => {
      button.focus()
      button.click()
    })
  }
  await click('button[aria-label^="Starts at:"]')
  await click('[data-day="2026-11-23"] button')
  await edit("start", "")
  await submit()
  expect(container.textContent).toContain("Choose a date and enter a time.")
  expect(submissions).toEqual([])

  await edit("start", "15:20:27")
  await click('button[aria-label="Clear Ends at"]')
  await submit()
  expect(submissions).toEqual([{ start: "2026-11-23 15:20:27", end: "" }])
})

// Owns the executable renderer seam: an unknown plugin uses real TanStack field
// state and shared validation. Artifact decoding is covered by installed fixtures.
test("unknown plugin receives public configuration and submits raw values only after shared validation", async () => {
  const unregister = registerRendererPlugin({
    type: "test-unknown-field",
    renderer: (form, component) => (
      <form.AppField name={component.field}>
        {(field) => (
          <label>
            {component.label}
            <input
              name={component.field}
              value={
                typeof field.state.value === "string" ? field.state.value : ""
              }
              onChange={(event) => field.handleChange(event.target.value)}
              onBlur={field.handleBlur}
            />
            <span>{JSON.stringify(component.pluginData)}</span>
          </label>
        )}
      </form.AppField>
    ),
  })
  let reject = true
  try {
    await act(async () =>
      root.render(
        <EffectSchemaForm
          schema={Schema.Struct({
            other: TextFieldFrom(
              Schema.String.check(Schema.isMinLength(1)),
            ).annotate({
              [FormComponentPluginType]: {
                module: "unknown",
                type: "test-unknown-field",
              },
            }),
            item: TextFieldFrom(
              Schema.Trim.check(Schema.isMinLength(3)),
            ).annotate({
              [FormComponentPluginType]: {
                module: "unknown",
                type: "test-unknown-field",
              },
            }),
          })}
          draftId="plugin-draft"
          defaultValues={{ other: "", item: "" }}
          pluginConfiguration={{ item: { hint: "Public server hint" } }}
          onSubmit={async (values) => {
            submissions.push(values)
            return reject
              ? [{ field: "item", message: "Plugin server rejection" }]
              : undefined
          }}
        >
          {() => <button type="submit">Submit</button>}
        </EffectSchemaForm>,
      ),
    )
    expect(container.textContent).toContain("Public server hint")
    await edit("other", "Valid other")
    await act(async () => input("other").blur())
    expect(
      [...container.querySelectorAll('[role="alert"]')].every(
        (alert) => !alert.textContent,
      ),
    ).toBe(true)
    // A browser commits blur before the subsequent click submits the form.
    await act(async () => {
      input("item").focus()
      input("item").blur()
    })
    await submit()
    expect(document.activeElement === input("item")).toBe(true)
    await edit("item", "x")
    await submit()
    expect(submissions).toEqual([])
    expect(document.activeElement === input("item")).toBe(true)
    await edit("item", "  Valid item  ")
    await submit()
    expect(submissions).toEqual([
      { other: "Valid other", item: "  Valid item  " },
    ])
    expect(container.textContent).toContain("Plugin server rejection")
    expect(document.activeElement === input("item")).toBe(true)
    reject = false
    await edit("item", "  Corrected item  ")
    expect(container.textContent).not.toContain("Plugin server rejection")
    await submit()
    expect(submissions.at(-1)).toEqual({
      other: "Valid other",
      item: "  Corrected item  ",
    })
    expect(dom.window.localStorage.getItem("plugin-draft")).toBeNull()
  } finally {
    unregister()
  }
})
test("calendar retries and radio choices submit encoded values through the shared renderer", async () => {
  let attempts = 0
  const fields = Schema.Struct({
    slot: CalendarSlotField({
      label: "Tour date",
      timeZone: "Pacific/Auckland",
      loadErrorMessageHtml: "Calendar unavailable",
    }),
    outcome: RadioField({
      label: "Outcome",
      options: [
        { value: "book", label: "Book tour" },
        { value: "cancel", label: "Cancel" },
      ],
    }),
  })
  await act(async () =>
    root.render(
      <LookupProvider
        value={{
          fetchSuggestions: async () => [],
          fetchDependentSuggestions: async () => [],
          fetchCalendarSlots: async () => {
            attempts++
            if (attempts === 1) throw new Error("External calendar unavailable")
            return [
              {
                value: "slot-1",
                startsAt: "2099-10-15T01:00:00Z",
                endsAt: "2099-10-15T01:30:00Z",
              },
            ]
          },
        }}
      >
        <EffectSchemaForm
          schema={fields}
          stepPath="/school/tour"
          draftId="calendar"
          defaultValues={{ slot: "", outcome: "" }}
          onSubmit={async (values) => {
            submissions.push(values)
          }}
        >
          {() => <button type="submit">Submit</button>}
        </EffectSchemaForm>
      </LookupProvider>,
    ),
  )
  expect(container.textContent).toContain("Calendar unavailable")
  const retryButton = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Try again",
  )
  expect(retryButton).toBeDefined()
  await act(async () => retryButton?.click())
  const day = container.querySelector<HTMLButtonElement>(
    "button[data-calendar-slot-day]:not([disabled])",
  )
  expect(day).not.toBeNull()
  await act(async () => day?.click())
  await act(async () =>
    container.querySelector<HTMLInputElement>('input[value="book"]')?.click(),
  )
  await submit()
  expect(submissions).toEqual([{ slot: "slot-1", outcome: "book" }])
})

test.each([true, false])(
  "calendar loading respects form focus (earlier text field: %s)",
  async (earlierTextField) => {
    const slots = Promise.withResolvers<CalendarSlotItem[]>()
    const slot = CalendarSlotField({ label: "Tour", timeZone: "UTC" })
    const fields = earlierTextField
      ? Schema.Struct({ name: TextFieldFrom(Schema.String), slot })
      : Schema.Struct({ slot })
    await act(async () =>
      root.render(
        <LookupProvider
          value={{
            fetchSuggestions: async () => [],
            fetchDependentSuggestions: async () => [],
            fetchCalendarSlots: () => slots.promise,
          }}
        >
          <EffectSchemaForm
            schema={fields}
            stepPath="/school/tour"
            draftId="calendar-focus"
            defaultValues={{ name: "", slot: "" }}
            onSubmit={async () => undefined}
          >
            {() => <button type="submit">Submit</button>}
          </EffectSchemaForm>
        </LookupProvider>,
      ),
    )
    const text = container.querySelector<HTMLInputElement>('input[id="name"]')
    if (earlierTextField) {
      expect(text).not.toBeNull()
      text?.focus()
      expect(document.activeElement).toBe(text)
    }
    await act(async () =>
      slots.resolve([
        {
          value: "slot-1",
          startsAt: new Date().toISOString(),
          endsAt: new Date(Date.now() + 1_800_000).toISOString(),
        },
      ]),
    )
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)))
    const day = container.querySelector<HTMLButtonElement>(
      "button[data-calendar-slot-day]:not([disabled])",
    )
    expect(day).not.toBeNull()
    expect(document.activeElement).toBe(earlierTextField ? text : day)
  },
)

test("list rows retain lookup selections when adding and removing students", async () => {
  const fields = Schema.Struct({
    students: ListField(
      { students: LookupField({ label: "Student" }) },
      {
        label: "Students",
        addButtonLabel: "Another student",
      },
    ),
  })
  const requests: string[] = []
  await act(async () =>
    root.render(
      <LookupProvider
        value={{
          fetchSuggestions: async (_step, field) => {
            requests.push(field)
            return [
              { value: "101", label: "First student" },
              { value: "102", label: "Second student" },
            ]
          },
          fetchDependentSuggestions: async () => [],
          fetchCalendarSlots: async () => [],
        }}
      >
        <EffectSchemaForm
          schema={fields}
          stepPath="/permission/Select students"
          draftId="list-rows"
          defaultValues={{ students: [{ students: "" }] }}
          onSubmit={async (values) => {
            submissions.push(values)
            return undefined
          }}
        >
          {() => <button type="submit">Submit</button>}
        </EffectSchemaForm>
      </LookupProvider>,
    ),
  )
  const click = async (text: string) => {
    const button = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === text,
    )
    expect(button).toBeDefined()
    await act(async () => button?.click())
  }
  const choose = async (index: number, label: string) => {
    const control = container.querySelectorAll<HTMLInputElement>(
      'input[role="combobox"]',
    )[index]
    if (!control) throw new Error("Missing student lookup")
    await act(async () => {
      control.focus()
      control.click()
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350))
    })
    const option = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    ).find((option) => option.textContent?.includes(label))
    if (!option) throw new Error("Missing student option")
    await act(async () => option.click())
  }
  await choose(0, "First student")
  await click("Another student")
  await choose(1, "Second student")
  await click("Remove")
  await act(async () => new Promise((resolve) => setTimeout(resolve, 350)))
  expect(container.querySelectorAll('input[role="combobox"]')).toHaveLength(1)
  expect(
    container.querySelector<HTMLInputElement>('input[role="combobox"]')?.value,
  ).toContain("Second student")
  expect(requests.length).toBeGreaterThan(0)
  expect(requests.every((field) => field === "students")).toBe(true)
  await submit()
  expect(submissions).toEqual([{ students: [{ students: "102" }] }])
})

test("text areas preserve paragraph breaks through editing and submission", async () => {
  await act(async () =>
    root.render(
      <EffectSchemaForm
        schema={Schema.Struct({
          introduction: TextArea({ label: "Dear parent," }),
        })}
        draftId="multiline-introduction"
        defaultValues={{ introduction: "" }}
        onSubmit={async (values) => {
          submissions.push(values)
        }}
      >
        {() => <button type="submit">Submit</button>}
      </EffectSchemaForm>,
    ),
  )
  const element = container.querySelector('textarea[name="introduction"]')
  expect(element).not.toBeNull()
  if (!(element instanceof dom.window.HTMLTextAreaElement))
    throw new Error("Missing multiline introduction control")
  const introduction = "First paragraph\n\nSecond paragraph"
  await act(async () => {
    element.focus()
    const setter = Object.getOwnPropertyDescriptor(
      dom.window.HTMLTextAreaElement.prototype,
      "value",
    )?.set
    if (!setter) throw new Error("Missing native textarea setter")
    setter.call(element, introduction)
    element.dispatchEvent(new dom.window.Event("input", { bubbles: true }))
    const event = new dom.window.Event("propertychange", { bubbles: true })
    Object.defineProperty(event, "propertyName", { value: "value" })
    element.dispatchEvent(event)
  })
  await submit()
  expect(submissions).toEqual([{ introduction }])
})

test("read-only details render wrappers and stack list values as rows", async () => {
  const detailSchema = Schema.Struct({
    enabled: ReadOnly(Schema.Boolean),
    verified: ReadOnly(Schema.Boolean),
    orderNumber: Schema.String.annotate({
      title: "Order number",
      [FormReadOnly]: true,
    }),
    items: Wrapper({
      orderLines: Schema.Array(Schema.String).annotate({
        title: "Line items",
        [FormReadOnly]: true,
      }),
      price: Schema.String.annotate({
        title: "Total (NZD)",
        [FormReadOnly]: true,
      }),
    }).annotate({ [FormLabel]: "Items" }),
    note: TextBlock("Thank you for your order."),
  })
  await act(async () =>
    root.render(
      <EffectSchemaForm
        schema={detailSchema}
        draftId="read-only-detail"
        readOnlyCheckboxFields={["enabled"]}
        defaultValues={{
          enabled: true,
          verified: true,
          orderNumber: "INV-0060",
          orderLines: ["MRIB/ABK × 1 — NZD 29.00", "PLANK/2M × 4 — NZD 12.00"],
          price: "41.00",
        }}
        onSubmit={async (values) => {
          submissions.push(values)
        }}
      >
        {() => <button type="submit">Submit</button>}
      </EffectSchemaForm>,
    ),
  )
  const orderNumber = container.querySelector("#orderNumber")
  if (!(orderNumber instanceof dom.window.HTMLInputElement))
    throw new Error("Missing read-only order number control")
  expect(orderNumber.value).toBe("INV-0060")
  const enabled = container.querySelector<HTMLInputElement>("#enabled")
  expect(enabled?.type).toBe("checkbox")
  expect(enabled?.checked).toBe(true)
  expect(enabled?.disabled).toBe(true)
  const verified = container.querySelector<HTMLInputElement>("#verified")
  expect(verified?.type).toBe("text")
  expect(verified?.value).toBe("true")
  expect(verified?.readOnly).toBe(true)
  const rows = [...container.querySelectorAll("fieldset li")].map(
    (row) => row.textContent,
  )
  expect(rows).toEqual(["MRIB/ABK × 1 — NZD 29.00", "PLANK/2M × 4 — NZD 12.00"])
  expect(container.textContent).toContain("Items")
  expect(container.textContent).toContain("Total (NZD)")
  expect(container.textContent).toContain("Thank you for your order.")
  const total = container.querySelector("#price")
  if (!(total instanceof dom.window.HTMLInputElement))
    throw new Error("Missing read-only total control")
  expect(total.value).toBe("41.00")
  // Flatten wrapper children stay at top-level ids/paths.
  expect(container.querySelector("#price")).not.toBeNull()
  expect(container.querySelector('[id="items.price"]')).toBeNull()
})
