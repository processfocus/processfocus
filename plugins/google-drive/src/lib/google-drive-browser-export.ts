const GOOGLE_DRIVE_API_BASE = "https://www.googleapis.com/drive/v3/files"
const GOOGLE_DOCUMENT_MIME_TYPE = "application/vnd.google-apps.document"
const PDF_MIME_TYPE = "application/pdf"

export const GOOGLE_DRIVE_PDF_MIME_TYPES = [
  GOOGLE_DOCUMENT_MIME_TYPE,
  "application/vnd.google-apps.spreadsheet",
  "application/vnd.google-apps.presentation",
  "application/vnd.google-apps.drawing",
  PDF_MIME_TYPE,
] as const

const googleDrivePdfMimeTypes: ReadonlySet<string> = new Set(
  GOOGLE_DRIVE_PDF_MIME_TYPES,
)

interface GoogleDriveSelectedFile {
  readonly id: string
  readonly name: string
  readonly mimeType: string
  readonly url: string
}

interface UploadUrlRequest {
  readonly stepPath: string
  readonly documentStore: string
  readonly contentType: string
  readonly filename: string
}

interface UploadUrlResult {
  readonly fileId: string
  readonly uploadUrl: string
}

interface ExportGoogleDriveFileInput {
  readonly file: GoogleDriveSelectedFile
  readonly accessToken: string
  readonly stepPath: string
  readonly documentStore: string
  readonly requestUploadUrl: (
    input: UploadUrlRequest,
  ) => Promise<UploadUrlResult>
  readonly deleteFile: (fileId: string) => Promise<void>
  readonly fetch?: (
    url: string,
    init?: RequestInit | undefined,
  ) => Promise<Response>
}

export interface GeneratedPdfArtifact {
  readonly fileId: string
  readonly filename: string
}

export type GoogleDriveBrowserExportErrorCode =
  | "drive-network"
  | "drive-authorization"
  | "drive-access"
  | "drive-export"
  | "upload-preparation"
  | "upload-network"
  | "upload-rejected"

export class GoogleDriveBrowserExportError extends Error {
  readonly code: GoogleDriveBrowserExportErrorCode

  constructor(code: GoogleDriveBrowserExportErrorCode, message: string) {
    super(message)
    this.name = "GoogleDriveBrowserExportError"
    this.code = code
  }
}

const pdfFilename = (name: string): string => {
  const baseName = name.replace(/\.pdf$/i, "")
  return `${baseName || "document"}.pdf`
}

const driveExportUrl = (file: GoogleDriveSelectedFile): string => {
  const fileUrl = `${GOOGLE_DRIVE_API_BASE}/${encodeURIComponent(file.id)}`
  if (file.mimeType === PDF_MIME_TYPE) {
    return `${fileUrl}?alt=media`
  }
  if (googleDrivePdfMimeTypes.has(file.mimeType)) {
    return `${fileUrl}/export?mimeType=${encodeURIComponent("application/pdf")}`
  }
  throw new Error(
    "Select a Google document, spreadsheet, presentation, drawing, or PDF.",
  )
}

const driveDownloadUrl = (file: GoogleDriveSelectedFile): string =>
  file.mimeType === GOOGLE_DOCUMENT_MIME_TYPE
    ? `https://docs.google.com/document/d/${encodeURIComponent(file.id)}/export?format=pdf&tab=t.0`
    : driveExportUrl(file)

const isPdfResponse = (response: Response): boolean =>
  response.ok &&
  response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase() === PDF_MIME_TYPE

const driveExportError = (status: number): GoogleDriveBrowserExportError => {
  switch (status) {
    case 401:
      return new GoogleDriveBrowserExportError(
        "drive-authorization",
        "Google Drive authorization expired. Select Try again to reauthorize.",
      )
    case 403:
      return new GoogleDriveBrowserExportError(
        "drive-access",
        "Google Drive did not grant access to export this file. Select Try again to reauthorize and choose it again.",
      )
    case 404:
      return new GoogleDriveBrowserExportError(
        "drive-export",
        "The selected Google Drive file is no longer available.",
      )
    case 429:
      return new GoogleDriveBrowserExportError(
        "drive-export",
        "Google Drive is temporarily rate-limited. Please try again shortly.",
      )
    default:
      return new GoogleDriveBrowserExportError(
        "drive-export",
        `Google Drive could not export the selected file (${status}).`,
      )
  }
}

const downloadPdf = async ({
  file,
  accessToken,
  fetchRequest,
}: {
  readonly file: GoogleDriveSelectedFile
  readonly accessToken: string
  readonly fetchRequest: NonNullable<ExportGoogleDriveFileInput["fetch"]>
}): Promise<Blob> => {
  const authorization = { Authorization: `Bearer ${accessToken}` }

  if (file.mimeType === GOOGLE_DOCUMENT_MIME_TYPE) {
    try {
      const documentResponse = await fetchRequest(driveDownloadUrl(file), {
        headers: authorization,
      })
      if (isPdfResponse(documentResponse)) {
        try {
          return await documentResponse.blob()
        } catch {
          // Fall back to the supported Drive export endpoint below.
        }
      }
    } catch {
      // A rejected request also means the undocumented endpoint failed. Let
      // the supported Drive fallback determine any user-facing error.
    }
  }

  let driveResponse: Response
  try {
    driveResponse = await fetchRequest(driveExportUrl(file), {
      headers: authorization,
    })
  } catch {
    throw new GoogleDriveBrowserExportError(
      "drive-network",
      "Your browser could not connect to Google Drive. Check your connection and try again.",
    )
  }
  if (!driveResponse.ok) {
    throw driveExportError(driveResponse.status)
  }

  try {
    return await driveResponse.blob()
  } catch {
    throw new GoogleDriveBrowserExportError(
      "drive-export",
      "The exported Google Drive file could not be read. Please try again.",
    )
  }
}

export const exportGoogleDriveFileToDocumentStore = async ({
  file,
  accessToken,
  stepPath,
  documentStore,
  requestUploadUrl,
  deleteFile,
  fetch: fetchRequest = fetch,
}: ExportGoogleDriveFileInput): Promise<GeneratedPdfArtifact> => {
  const filename = pdfFilename(file.name)
  const pdf = await downloadPdf({ file, accessToken, fetchRequest })

  let upload: UploadUrlResult
  try {
    upload = await requestUploadUrl({
      stepPath,
      documentStore,
      contentType: "application/pdf",
      filename,
    })
  } catch {
    throw new GoogleDriveBrowserExportError(
      "upload-preparation",
      "Process Focus could not prepare the PDF upload. Please try again.",
    )
  }

  try {
    let uploadResponse: Response
    try {
      uploadResponse = await fetchRequest(upload.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/pdf" },
        body: pdf,
      })
    } catch {
      throw new GoogleDriveBrowserExportError(
        "upload-network",
        "Your browser could not upload the exported PDF. Check your connection and try again.",
      )
    }
    if (!uploadResponse.ok) {
      throw new GoogleDriveBrowserExportError(
        "upload-rejected",
        `PDF upload failed (${uploadResponse.status}). Please try again.`,
      )
    }
  } catch (error) {
    await deleteFile(upload.fileId).catch(() => undefined)
    throw error
  }

  return { fileId: upload.fileId, filename }
}
