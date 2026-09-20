import { Schema as ES, Effect } from "effect"
import {
  asClientRepresentation,
  registerWalkerPlugin,
  unregisterWalkerPlugin,
} from "@pf/form-client-representation"
import type { PluginField } from "@pf/form-client-representation/types"
import { FormComponentType } from "@pf/form-client-representation/types"
import {
  FormComponentPluginType,
  FormFileInput,
  FormLabel,
} from "@pf/form-schema"
import {
  FormGoogleDriveGeneratePdf,
  FormGoogleDriveInput,
  GoogleDriveField,
  isGoogleDriveGeneratedPdf,
  parseGoogleDriveGeneratedPdf,
  parseGoogleDriveValue,
} from "./google-drive-field"
import { afterEach, beforeEach, describe, expect, it } from "bun:test"

const PLUGIN_TYPE = "google-drive"
/** Sentinel that must never appear in serialized process-state field values. */
const SENTINEL_TOKEN = "ya29.sentinel-access-token-must-not-appear-in-state"

// Register the walker plugin the same way the real register module does
beforeEach(() => {
  registerWalkerPlugin({
    type: PLUGIN_TYPE,
    matchAnnotation: (a) => a[FormGoogleDriveInput] === true,
  })
})

afterEach(() => {
  unregisterWalkerPlugin(PLUGIN_TYPE)
})

describe("GoogleDriveField schema constructor", () => {
  it("creates a string schema with the GoogleDriveInput annotation", () => {
    const field = GoogleDriveField()
    const ast = field.ast

    // Walk up through Transformation to find the annotation on the inner type
    const annotations =
      ast._tag === "Transformation" ? ast.from.annotations : ast.annotations
    expect(annotations[FormGoogleDriveInput]).toBe(true)
    expect(annotations[FormComponentPluginType]).toEqual({
      module: "@processfocus/plugin-google-drive/register-client",
      type: "google-drive",
    })
  })

  it("accepts and applies a custom label", () => {
    const field = GoogleDriveField({ label: "Select document" })
    const ast = field.ast
    const annotations =
      ast._tag === "Transformation" ? ast.from.annotations : ast.annotations
    expect(annotations[FormLabel]).toBe("Select document")
  })

  it("declares the document store used by browser-generated PDFs", () => {
    const field = GoogleDriveField({
      generatePdf: { node: { path: "School/journey-pdfs" } },
    })
    const ast = field.ast
    const annotations =
      ast._tag === "Transformation" ? ast.from.annotations : ast.annotations

    expect(annotations[FormGoogleDriveGeneratePdf]).toEqual({
      documentStore: "/School/journey-pdfs",
    })
    expect(annotations[FormFileInput]).toEqual({
      documentStore: "/School/journey-pdfs",
    })
  })

  it("validates as a string schema", () => {
    const field = GoogleDriveField()
    const result = ES.decodeUnknownSync(field)('{"id":"abc"}')
    expect(result).toBe('{"id":"abc"}')
  })

  it("rejects non-string values", () => {
    const field = GoogleDriveField()
    expect(() => ES.decodeUnknownSync(field)(123)).toThrow()
  })

  it("accepts only uploaded PDF references when generatePdf is configured", () => {
    const field = GoogleDriveField({
      generatePdf: { node: { path: "School/journey-pdfs" } },
    })
    const generatedPdf = JSON.stringify({
      fileId: "file-uploaded-pdf",
      filename: "Trip plan.pdf",
    })

    expect(ES.decodeUnknownSync(field)(generatedPdf)).toBe(generatedPdf)
    expect(() =>
      ES.decodeUnknownSync(field)(
        JSON.stringify({
          id: "drive-file-1",
          name: "Trip plan",
          mimeType: "application/vnd.google-apps.document",
          url: "https://drive.google.com/file/d/drive-file-1",
        }),
      ),
    ).toThrow()
  })
})

describe("parseGoogleDriveValue", () => {
  it("parses a JSON string into a DrivePickerFile", () => {
    const json = JSON.stringify({
      id: "file-123",
      name: "report.pdf",
      mimeType: "application/pdf",
      url: "https://drive.google.com/file/d/file-123",
    })

    const result = parseGoogleDriveValue(json)

    expect(result.id).toBe("file-123")
    expect(result.name).toBe("report.pdf")
    expect(result.mimeType).toBe("application/pdf")
    expect(result.url).toBe("https://drive.google.com/file/d/file-123")
  })

  it("round-trips with JSON.stringify", () => {
    const original = {
      id: "abc",
      name: "test.txt",
      mimeType: "text/plain",
      url: "https://example.com",
    }
    const parsed = parseGoogleDriveValue(JSON.stringify(original))
    expect(parsed).toEqual(original)
  })

  it("rejects credential handoff metadata", () => {
    const json = JSON.stringify({
      id: "file-123",
      name: "report.pdf",
      mimeType: "application/pdf",
      url: "https://drive.google.com/file/d/file-123",
      credentialReference: "opaque-handoff-ref",
    })
    expect(() => parseGoogleDriveValue(json)).toThrow()
  })

  it("rejects objects missing required fields", () => {
    const incomplete = JSON.stringify({ id: "abc", name: "test.txt" })
    expect(() => parseGoogleDriveValue(incomplete)).toThrow()
  })

  it("rejects invalid JSON", () => {
    expect(() => parseGoogleDriveValue("not json")).toThrow()
  })

  it("rejects non-string field values", () => {
    const bad = JSON.stringify({
      id: 123,
      name: "test.txt",
      mimeType: "text/plain",
      url: "https://example.com",
    })
    expect(() => parseGoogleDriveValue(bad)).toThrow()
  })
})

describe("parseGoogleDriveGeneratedPdf", () => {
  it("does not accept bearer tokens or credential references", () => {
    const withToken = JSON.stringify({
      fileId: "file-1",
      filename: "doc.pdf",
      accessToken: SENTINEL_TOKEN,
    })
    const withReference = JSON.stringify({
      fileId: "file-1",
      filename: "doc.pdf",
      credentialReference: "ref-abc",
    })

    expect(() => parseGoogleDriveGeneratedPdf(withToken)).toThrow()
    expect(() => parseGoogleDriveGeneratedPdf(withReference)).toThrow()
  })
})

describe("GoogleDriveField walker integration", () => {
  it("produces a PluginField through asClientRepresentation", () => {
    const schema = ES.Struct({
      document: GoogleDriveField({ label: "Upload document" }),
    })

    const result = Effect.runSync(asClientRepresentation(schema))
    const field = result.document as unknown as PluginField

    expect(field._tag).toBe(FormComponentType.Plugin)
    expect(field.pluginType).toBe(PLUGIN_TYPE)
    expect(field.field).toBe("document")
    expect(field.label).toBe("Upload document")
  })

  it("coexists with standard fields in a struct", () => {
    const schema = ES.Struct({
      title: ES.String,
      attachment: GoogleDriveField({ label: "Attachment" }),
      count: ES.Number,
    })

    const result = Effect.runSync(asClientRepresentation(schema))

    expect(result.title._tag).toBe(FormComponentType.Text)
    expect((result.attachment as unknown as PluginField)._tag).toBe(
      FormComponentType.Plugin,
    )
    expect(result.count._tag).toBe(FormComponentType.Number)
  })
})

describe("process-state serialization contract", () => {
  it("rejects empty and malformed generated PDFs at the form boundary", () => {
    expect(isGoogleDriveGeneratedPdf("")).toBe(false)
    expect(isGoogleDriveGeneratedPdf("not-json")).toBe(false)
    expect(
      isGoogleDriveGeneratedPdf(
        JSON.stringify({ fileId: "", filename: "Trip plan.pdf" }),
      ),
    ).toBe(false)
    expect(
      isGoogleDriveGeneratedPdf(
        JSON.stringify({
          fileId: "file-uploaded-pdf",
          filename: "Trip plan.pdf",
        }),
      ),
    ).toBe(true)
  })

  it("stores the uploaded PDF reference but never the browser bearer token", () => {
    const serialized = JSON.stringify({
      fileId: "file-uploaded-pdf",
      filename: "Trip plan.pdf",
    })
    expect(serialized).not.toContain(SENTINEL_TOKEN)
    expect(serialized).not.toContain("accessToken")
    expect(serialized).not.toContain("ya29.")

    const parsed = parseGoogleDriveGeneratedPdf(serialized)
    expect(parsed).toEqual({
      fileId: "file-uploaded-pdf",
      filename: "Trip plan.pdf",
    })
  })

  it("rejects obsolete credential references", () => {
    const serialized = JSON.stringify({
      id: "drive-file-1",
      name: "Trip plan",
      mimeType: "application/vnd.google-apps.document",
      url: "https://drive.google.com/file/d/drive-file-1",
      credentialReference: "opaque-ref-from-handoff",
    })
    expect(serialized).not.toContain(SENTINEL_TOKEN)
    expect(serialized).not.toContain("accessToken")
    expect(serialized).not.toContain("ya29.")
    expect(isGoogleDriveGeneratedPdf(serialized)).toBe(false)
    expect(() => parseGoogleDriveGeneratedPdf(serialized)).toThrow()
  })
})
