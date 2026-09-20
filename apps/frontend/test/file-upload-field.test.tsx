import { JSDOM } from "jsdom"
import { act } from "react"
import { type Root, createRoot } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import {
  FileField,
  FileUploadProvider,
  type FileUploadService,
  useAppForm,
} from "@pf/shadcn-components"

describe("FileField", () => {
  let cleanupDom: (() => void) | undefined
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    cleanupDom = installDom()
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    FakeXMLHttpRequest.instances = []
    FakeXMLHttpRequest.nextEvent = "load"
    FakeXMLHttpRequest.nextStatus = 200
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    cleanupDom?.()
    vi.restoreAllMocks()
  })

  test.each([
    ["text/plain", "text/plain"],
    ["", "application/octet-stream"],
  ])(
    "uploads the selected filename with content type %s",
    async (fileType, expectedContentType) => {
      const requestUploadUrl = vi.fn(async () => ({
        fileId: "file-123",
        uploadUrl: "https://uploads.example.com/file-123",
      }))
      renderField({ requestUploadUrl })

      const file = new File(["file contents"], "report.txt", {
        type: fileType,
      })
      await selectFile(file)

      expect(requestUploadUrl).toHaveBeenCalledWith({
        stepPath: "/process/upload",
        documentStore: "/documents",
        contentType: expectedContentType,
        filename: "report.txt",
      })
      expect(FakeXMLHttpRequest.instances).toHaveLength(1)
      const xhr = FakeXMLHttpRequest.instances[0]
      expect(xhr?.method).toBe("PUT")
      expect(xhr?.url).toBe("https://uploads.example.com/file-123")
      expect(xhr?.headers.get("Content-Type")).toBe(expectedContentType)
      expect(xhr?.body).toBe(file)
      expect(container.textContent).toContain("report.txt")
    },
  )

  test("shows upload errors through the field error path", async () => {
    const requestUploadUrl = vi.fn(() =>
      Promise.reject(new Error("Document store unavailable")),
    )
    renderField({ requestUploadUrl })

    await selectFile(new File(["contents"], "failed.txt"))

    expect(container.textContent).toContain("failed.txt")
    expect(container.textContent).toContain("Document store unavailable")
  })

  test.each([
    ["load", 503, "Upload failed with status 503"],
    ["error", 0, "Upload failed"],
  ] as const)(
    "shows %s upload failures through the field error path",
    async (event, status, expectedMessage) => {
      FakeXMLHttpRequest.nextEvent = event
      FakeXMLHttpRequest.nextStatus = status
      renderField({
        requestUploadUrl: async () => ({
          fileId: "file-123",
          uploadUrl: "https://uploads.example.com/file-123",
        }),
      })

      await selectFile(new File(["contents"], "failed.txt"))

      expect(container.textContent).toContain("failed.txt")
      expect(container.textContent).toContain(expectedMessage)
    },
  )

  const renderField = (service: FileUploadService): void => {
    act(() => {
      root.render(<FileFieldHarness service={service} />)
    })
  }

  const selectFile = async (file: File): Promise<void> => {
    const input = container.querySelector("input[type=file]")
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("File input was not rendered")
    }
    Object.defineProperty(input, "files", { configurable: true, value: [file] })

    await act(async () => {
      input.dispatchEvent(new window.Event("change", { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
})

const FileFieldHarness = ({ service }: { service: FileUploadService }) => {
  const form = useAppForm({
    defaultValues: { attachment: "" },
  })

  return (
    <FileUploadProvider value={service}>
      <form.AppForm>
        <form.AppField name="attachment">
          {() => (
            <FileField
              label="Attachment"
              documentStore="/documents"
              stepPath="/process/upload"
            />
          )}
        </form.AppField>
      </form.AppForm>
    </FileUploadProvider>
  )
}

type XhrListener = () => void
type XhrEvent = "error" | "load"

class FakeXMLHttpRequest {
  static instances: FakeXMLHttpRequest[] = []
  static nextEvent: XhrEvent = "load"
  static nextStatus = 200

  readonly headers = new Map<string, string>()
  readonly upload = { addEventListener: vi.fn() }
  readonly listeners = new Map<string, XhrListener>()
  readonly status = FakeXMLHttpRequest.nextStatus
  body: Document | XMLHttpRequestBodyInit | null = null
  method = ""
  url = ""

  constructor() {
    FakeXMLHttpRequest.instances.push(this)
  }

  addEventListener(type: string, listener: XhrListener): void {
    this.listeners.set(type, listener)
  }

  open(method: string, url: string): void {
    this.method = method
    this.url = url
  }

  setRequestHeader(name: string, value: string): void {
    this.headers.set(name, value)
  }

  send(body: Document | XMLHttpRequestBodyInit | null): void {
    this.body = body
    this.listeners.get(FakeXMLHttpRequest.nextEvent)?.()
  }
}

const installDom = (): (() => void) => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://console.example.com",
  })
  const previousGlobals = {
    document: globalThis.document,
    File: globalThis.File,
    HTMLElement: globalThis.HTMLElement,
    HTMLInputElement: globalThis.HTMLInputElement,
    navigator: globalThis.navigator,
    window: globalThis.window,
    XMLHttpRequest: globalThis.XMLHttpRequest,
  }

  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    document: dom.window.document,
    File: dom.window.File,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    navigator: dom.window.navigator,
    window: dom.window,
    XMLHttpRequest: FakeXMLHttpRequest,
  })

  return () => {
    dom.window.close()
    Object.assign(globalThis, previousGlobals)
    delete globalThis.IS_REACT_ACT_ENVIRONMENT
  }
}
