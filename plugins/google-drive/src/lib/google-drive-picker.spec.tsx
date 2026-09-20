import { renderToStaticMarkup } from "react-dom/server"
import {
  GoogleDrivePicker,
  SelectedGoogleDriveFile,
  type SelectedGoogleDriveFileProps,
} from "./google-drive-picker"
import { GOOGLE_DRIVE_NOT_CONFIGURED_USER_MESSAGE } from "./google-drive-picker-config"
import { describe, expect, it } from "bun:test"

const unusedUpload = async () => {
  throw new Error("upload should not run")
}

describe("Google Drive Picker missing configuration", () => {
  it("shows a form-user message without environment-variable names", () => {
    const html = renderToStaticMarkup(
      <GoogleDrivePicker
        field={{
          state: { value: "" },
          handleChange: () => undefined,
        }}
        label="Tramping plan"
        requestUploadUrl={unusedUpload}
        requestDownloadUrl={unusedUpload}
        deleteFile={async () => undefined}
      />,
    )

    expect(html).toContain(GOOGLE_DRIVE_NOT_CONFIGURED_USER_MESSAGE)
    expect(html).not.toContain("GOOGLE_DRIVE_")
    expect(html).not.toContain("NEXT_PUBLIC_")
    expect(html.toLowerCase()).not.toContain("credential")
    expect(html).not.toContain("Select file")
  })

  it("renders the picker actions when Picker configuration is present", () => {
    const html = renderToStaticMarkup(
      <GoogleDrivePicker
        field={{
          state: { value: "" },
          handleChange: () => undefined,
        }}
        label="Tramping plan"
        clientId="drive-client"
        appId="drive-app"
        developerKey="drive-developer-key"
        requestUploadUrl={unusedUpload}
        requestDownloadUrl={unusedUpload}
        deleteFile={async () => undefined}
      />,
    )

    expect(html).not.toContain(GOOGLE_DRIVE_NOT_CONFIGURED_USER_MESSAGE)
    expect(html).toContain("Loading Google Drive picker...")
  })
})

const HARD_CODED_GRAY_CLASS = /\b(?:bg|border|text)-gray-\d+\b/
const HARD_CODED_BLUE_CLASS = /\btext-blue-\d+\b/
const LONG_FILE_NAME =
  "Very-long-adventurous-journey-information-document-name-that-should-wrap-instead-of-overflowing-the-form.pdf"

const renderSelectedFile = (props: SelectedGoogleDriveFileProps) =>
  renderToStaticMarkup(<SelectedGoogleDriveFile {...props} />)

describe("SelectedGoogleDriveFile theme contract", () => {
  it("uses semantic tokens for the editable selected-file surface", () => {
    const html = renderSelectedFile({
      kind: "editable",
      fileName: "Trip plan.pdf",
    })

    expect(html).toContain("bg-muted")
    expect(html).toContain("border-input")
    expect(html).toContain("min-w-0")
    expect(html).toContain("max-w-full")
    expect(html).toContain("text-foreground")
    expect(html).toContain("break-all")
    expect(html).toContain("Trip plan.pdf")
    expect(html).not.toMatch(HARD_CODED_GRAY_CLASS)
  })

  it("keeps long editable filenames wrapped instead of truncated", () => {
    const html = renderSelectedFile({
      kind: "editable",
      fileName: LONG_FILE_NAME,
    })

    expect(html).toContain("break-all")
    expect(html).not.toContain("truncate")
    expect(html).toContain(LONG_FILE_NAME)
  })

  it("uses semantic tokens for the read-only Drive link", () => {
    const html = renderSelectedFile({
      kind: "link",
      fileName: LONG_FILE_NAME,
      href: "https://drive.google.com/file/d/file-123",
    })

    expect(html).toContain("<a ")
    expect(html).toContain('href="https://drive.google.com/file/d/file-123"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain("text-primary")
    expect(html).toContain("break-all")
    expect(html).toContain("max-w-full")
    expect(html).toContain(LONG_FILE_NAME)
    expect(html).not.toMatch(HARD_CODED_GRAY_CLASS)
    expect(html).not.toMatch(HARD_CODED_BLUE_CLASS)
  })

  it("uses semantic tokens for the read-only stored-PDF opener", () => {
    const html = renderSelectedFile({
      kind: "stored-pdf",
      fileName: LONG_FILE_NAME,
      opening: false,
      onOpen: () => undefined,
    })

    expect(html).toContain("<button")
    expect(html).toContain('type="button"')
    expect(html).not.toMatch(/\sdisabled(?:=|>|\s)/)
    expect(html).toContain("text-primary")
    expect(html).toContain("break-all")
    expect(html).toContain("max-w-full")
    expect(html).toContain(LONG_FILE_NAME)
    expect(html).not.toMatch(HARD_CODED_GRAY_CLASS)
    expect(html).not.toMatch(HARD_CODED_BLUE_CLASS)
  })

  it("keeps Opening PDF... copy while a stored file is opening", () => {
    const html = renderSelectedFile({
      kind: "stored-pdf",
      fileName: "Trip plan.pdf",
      opening: true,
      onOpen: () => undefined,
    })

    expect(html).toMatch(/\sdisabled(?:=|>|\s)/)
    expect(html).toContain("Opening PDF...")
    expect(html).not.toContain("Trip plan.pdf")
  })
})

describe("Google Drive plugin selected-file theme tokens", () => {
  it("maps foreground, muted, input, and primary tokens in plugin styles", async () => {
    const css = await Bun.file(
      new URL("../../styles.css", import.meta.url),
    ).text()

    expect(css).toContain("--color-foreground: var(--foreground);")
    expect(css).toContain("--color-muted: var(--muted);")
    expect(css).toContain("--color-input: var(--input);")
    expect(css).toContain("--color-primary: var(--primary);")
  })
})
