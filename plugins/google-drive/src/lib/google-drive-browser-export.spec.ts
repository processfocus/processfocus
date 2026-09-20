import {
  GoogleDriveBrowserExportError,
  exportGoogleDriveFileToDocumentStore,
} from "./google-drive-browser-export"
import { describe, expect, it } from "bun:test"

const SENTINEL_TOKEN = "ya29.browser-only-token"
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46])

const pdfResponse = (): Response =>
  new Response(PDF_BYTES, {
    status: 200,
    headers: { "content-type": "application/pdf" },
  })

describe("browser Google Drive PDF export", () => {
  it("exports the first Google Doc tab with the browser token and uploads only PDF bytes", async () => {
    const fetchCalls: Array<{
      readonly url: string
      readonly init: RequestInit | undefined
    }> = []
    let uploadRequest:
      | {
          readonly stepPath: string
          readonly documentStore: string
          readonly contentType: string
          readonly filename: string
        }
      | undefined

    const result = await exportGoogleDriveFileToDocumentStore({
      file: {
        id: "drive-file-1",
        name: "Journey information",
        mimeType: "application/vnd.google-apps.document",
        url: "https://docs.google.com/document/d/drive-file-1",
      },
      accessToken: SENTINEL_TOKEN,
      stepPath: "/request-eotc-permission/Select students",
      documentStore: "/journey-pdfs",
      requestUploadUrl: async (input) => {
        uploadRequest = input
        return {
          fileId: "file-uploaded-pdf",
          uploadUrl: "https://uploads.example.com/file-uploaded-pdf",
        }
      },
      deleteFile: async () => undefined,
      fetch: async (url, init) => {
        fetchCalls.push({ url, init })
        if (url.startsWith("https://docs.google.com/document/d/")) {
          return pdfResponse()
        }
        return new Response(null, { status: 200 })
      },
    })

    expect(uploadRequest).toEqual({
      stepPath: "/request-eotc-permission/Select students",
      documentStore: "/journey-pdfs",
      contentType: "application/pdf",
      filename: "Journey information.pdf",
    })
    expect(fetchCalls[0]).toMatchObject({
      url: "https://docs.google.com/document/d/drive-file-1/export?format=pdf&tab=t.0",
      init: {
        headers: { Authorization: `Bearer ${SENTINEL_TOKEN}` },
      },
    })
    expect(fetchCalls[1]).toMatchObject({
      url: "https://uploads.example.com/file-uploaded-pdf",
      init: {
        method: "PUT",
        headers: { "Content-Type": "application/pdf" },
      },
    })
    expect(JSON.stringify(fetchCalls[1])).not.toContain(SENTINEL_TOKEN)
    expect(result).toEqual({
      fileId: "file-uploaded-pdf",
      filename: "Journey information.pdf",
    })
  })

  const driveDownloadCases = [
    {
      label: "Google Sheets",
      mimeType: "application/vnd.google-apps.spreadsheet",
      expectedUrl:
        "https://www.googleapis.com/drive/v3/files/drive-file-1/export?mimeType=application%2Fpdf",
    },
    {
      label: "Google Slides",
      mimeType: "application/vnd.google-apps.presentation",
      expectedUrl:
        "https://www.googleapis.com/drive/v3/files/drive-file-1/export?mimeType=application%2Fpdf",
    },
    {
      label: "Google Drawings",
      mimeType: "application/vnd.google-apps.drawing",
      expectedUrl:
        "https://www.googleapis.com/drive/v3/files/drive-file-1/export?mimeType=application%2Fpdf",
    },
    {
      label: "existing PDFs",
      mimeType: "application/pdf",
      expectedUrl:
        "https://www.googleapis.com/drive/v3/files/drive-file-1?alt=media",
    },
  ]

  for (const { label, mimeType, expectedUrl } of driveDownloadCases) {
    it(`downloads ${label} through Drive`, async () => {
      const fetchCalls: Array<{
        readonly url: string
        readonly init: RequestInit | undefined
      }> = []

      await exportGoogleDriveFileToDocumentStore({
        file: {
          id: "drive-file-1",
          name: "Journey information",
          mimeType,
          url: "https://drive.google.com/file/d/drive-file-1",
        },
        accessToken: SENTINEL_TOKEN,
        stepPath: "/request-eotc-permission/Select students",
        documentStore: "/journey-pdfs",
        requestUploadUrl: async () => ({
          fileId: "file-uploaded-pdf",
          uploadUrl: "https://uploads.example.com/file-uploaded-pdf",
        }),
        deleteFile: async () => undefined,
        fetch: async (url, init) => {
          fetchCalls.push({ url, init })
          return url.startsWith("https://www.googleapis.com/drive/v3/files/")
            ? pdfResponse()
            : new Response(null, { status: 200 })
        },
      })

      expect(fetchCalls[0]).toEqual({
        url: expectedUrl,
        init: {
          headers: { Authorization: `Bearer ${SENTINEL_TOKEN}` },
        },
      })
      expect(
        fetchCalls.some(({ url }) => url.includes("docs.google.com")),
      ).toBe(false)
    })
  }

  it("falls back to Drive export when the Docs endpoint does not return an OK PDF", async () => {
    const downloadUrls: string[] = []

    await exportGoogleDriveFileToDocumentStore({
      file: {
        id: "drive-file-1",
        name: "Journey information",
        mimeType: "application/vnd.google-apps.document",
        url: "https://docs.google.com/document/d/drive-file-1",
      },
      accessToken: SENTINEL_TOKEN,
      stepPath: "/request-eotc-permission/Select students",
      documentStore: "/journey-pdfs",
      requestUploadUrl: async () => ({
        fileId: "file-uploaded-pdf",
        uploadUrl: "https://uploads.example.com/file-uploaded-pdf",
      }),
      deleteFile: async () => undefined,
      fetch: async (url) => {
        if (url.startsWith("https://uploads.example.com/")) {
          return new Response(null, { status: 200 })
        }
        downloadUrls.push(url)
        return url.startsWith("https://docs.google.com/")
          ? new Response("Google sign-in page", {
              status: 200,
              headers: { "content-type": "text/html" },
            })
          : pdfResponse()
      },
    })

    expect(downloadUrls).toEqual([
      "https://docs.google.com/document/d/drive-file-1/export?format=pdf&tab=t.0",
      "https://www.googleapis.com/drive/v3/files/drive-file-1/export?mimeType=application%2Fpdf",
    ])
  })

  it("falls back to Drive export when the Docs endpoint returns a non-OK status", async () => {
    const downloadCalls: Array<{
      readonly url: string
      readonly init: RequestInit | undefined
    }> = []

    await exportGoogleDriveFileToDocumentStore({
      file: {
        id: "drive-file-1",
        name: "Journey information",
        mimeType: "application/vnd.google-apps.document",
        url: "https://docs.google.com/document/d/drive-file-1",
      },
      accessToken: SENTINEL_TOKEN,
      stepPath: "/request-eotc-permission/Select students",
      documentStore: "/journey-pdfs",
      requestUploadUrl: async () => ({
        fileId: "file-uploaded-pdf",
        uploadUrl: "https://uploads.example.com/file-uploaded-pdf",
      }),
      deleteFile: async () => undefined,
      fetch: async (url, init) => {
        if (url.startsWith("https://uploads.example.com/")) {
          return new Response(null, { status: 200 })
        }
        downloadCalls.push({ url, init })
        return url.startsWith("https://docs.google.com/")
          ? new Response(null, { status: 403 })
          : pdfResponse()
      },
    })

    expect(downloadCalls).toEqual([
      {
        url: "https://docs.google.com/document/d/drive-file-1/export?format=pdf&tab=t.0",
        init: {
          headers: { Authorization: `Bearer ${SENTINEL_TOKEN}` },
        },
      },
      {
        url: "https://www.googleapis.com/drive/v3/files/drive-file-1/export?mimeType=application%2Fpdf",
        init: {
          headers: { Authorization: `Bearer ${SENTINEL_TOKEN}` },
        },
      },
    ])
  })

  it("falls back to Drive export when the Docs request rejects", async () => {
    const downloadUrls: string[] = []

    await exportGoogleDriveFileToDocumentStore({
      file: {
        id: "drive-file-1",
        name: "Journey information",
        mimeType: "application/vnd.google-apps.document",
        url: "https://docs.google.com/document/d/drive-file-1",
      },
      accessToken: SENTINEL_TOKEN,
      stepPath: "/request-eotc-permission/Select students",
      documentStore: "/journey-pdfs",
      requestUploadUrl: async () => ({
        fileId: "file-uploaded-pdf",
        uploadUrl: "https://uploads.example.com/file-uploaded-pdf",
      }),
      deleteFile: async () => undefined,
      fetch: async (url) => {
        if (url.startsWith("https://uploads.example.com/")) {
          return new Response(null, { status: 200 })
        }
        downloadUrls.push(url)
        if (url.startsWith("https://docs.google.com/")) {
          throw new TypeError("Failed to fetch")
        }
        return pdfResponse()
      },
    })

    expect(downloadUrls).toEqual([
      "https://docs.google.com/document/d/drive-file-1/export?format=pdf&tab=t.0",
      "https://www.googleapis.com/drive/v3/files/drive-file-1/export?mimeType=application%2Fpdf",
    ])
  })

  it("removes the file record when direct upload fails", async () => {
    const deletedFileIds: string[] = []

    const exportAndUpload = exportGoogleDriveFileToDocumentStore({
      file: {
        id: "drive-file-1",
        name: "Journey information",
        mimeType: "application/vnd.google-apps.document",
        url: "https://docs.google.com/document/d/drive-file-1",
      },
      accessToken: SENTINEL_TOKEN,
      stepPath: "/request-eotc-permission/Select students",
      documentStore: "/journey-pdfs",
      requestUploadUrl: async () => ({
        fileId: "file-failed-upload",
        uploadUrl: "https://uploads.example.com/file-failed-upload",
      }),
      deleteFile: async (fileId) => {
        deletedFileIds.push(fileId)
      },
      fetch: async (url) =>
        url.startsWith("https://docs.google.com/document/d/")
          ? pdfResponse()
          : new Response(null, { status: 500 }),
    })

    await expect(exportAndUpload).rejects.toThrow("PDF upload failed (500)")
    expect(deletedFileIds).toEqual(["file-failed-upload"])
  })

  it("reports a browser Drive connection failure without exposing the underlying error", async () => {
    const underlyingMessage = "Failed to fetch https://secret.example/token"

    const exportAndUpload = exportGoogleDriveFileToDocumentStore({
      file: {
        id: "drive-file-1",
        name: "Journey information",
        mimeType: "application/vnd.google-apps.document",
        url: "https://docs.google.com/document/d/drive-file-1",
      },
      accessToken: SENTINEL_TOKEN,
      stepPath: "/request-eotc-permission/Select students",
      documentStore: "/journey-pdfs",
      requestUploadUrl: async () => {
        throw new Error("must not be called")
      },
      deleteFile: async () => undefined,
      fetch: async () => {
        throw new TypeError(underlyingMessage)
      },
    })

    const error = await exportAndUpload.catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(GoogleDriveBrowserExportError)
    expect(error).toMatchObject({ code: "drive-network" })
    expect(String(error)).toContain(
      "Your browser could not connect to Google Drive",
    )
    expect(String(error)).not.toContain(underlyingMessage)
    expect(String(error)).not.toContain(SENTINEL_TOKEN)
  })

  it("identifies rejected Drive authorization so the picker can reauthorize", async () => {
    const exportAndUpload = exportGoogleDriveFileToDocumentStore({
      file: {
        id: "drive-file-1",
        name: "Journey information",
        mimeType: "application/vnd.google-apps.document",
        url: "https://docs.google.com/document/d/drive-file-1",
      },
      accessToken: SENTINEL_TOKEN,
      stepPath: "/request-eotc-permission/Select students",
      documentStore: "/journey-pdfs",
      requestUploadUrl: async () => {
        throw new Error("must not be called")
      },
      deleteFile: async () => undefined,
      fetch: async () => new Response(null, { status: 401 }),
    })

    const error = await exportAndUpload.catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(GoogleDriveBrowserExportError)
    expect(error).toMatchObject({ code: "drive-authorization" })
    expect(String(error)).toContain("authorization expired")
    expect(String(error)).not.toContain(SENTINEL_TOKEN)
  })
})
