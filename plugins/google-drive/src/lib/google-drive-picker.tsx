"use client"

import type React from "react"
import { useCallback, useEffect, useId, useRef, useState } from "react"
import { loadDrivePickerElement } from "./drive-picker-element-loader"
import {
  GOOGLE_DRIVE_PDF_MIME_TYPES,
  GoogleDriveBrowserExportError,
  exportGoogleDriveFileToDocumentStore,
} from "./google-drive-browser-export"
import { openStoredGoogleDrivePdf } from "./google-drive-download"
import { requestGoogleDriveAccessToken } from "./google-drive-oauth"
import {
  GOOGLE_DRIVE_NOT_CONFIGURED_USER_MESSAGE,
  googleDrivePickerConfigurationDiagnostics,
} from "./google-drive-picker-config"
import {
  clearPickerTokenCache,
  getCachedPickerToken,
  setCachedPickerToken,
} from "./picker-token-cache"
import type { Google, TokenResponse } from "./types"

/**
 * JSX augmentation for Google Drive Picker custom elements.
 * Inlined here because Next.js incremental mode does not pick up
 * standalone .d.ts augmentation files from referenced projects.
 */
declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "drive-picker": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          "app-id"?: string
          "client-id"?: string
          "developer-key"?: string
          "oauth-token"?: string
          mime?: string
          multiselect?: boolean
        },
        HTMLElement
      >
      "drive-picker-docs-view": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          "include-folders"?: string
          "mime-types"?: string
        },
        HTMLElement
      >
    }
  }
}

/** Access the GIS global loaded by the external script. */
function getGIS(): Google {
  const g = (globalThis as Record<string, unknown>)["google"] as
    | Google
    | undefined
  if (!g?.accounts?.oauth2) {
    throw new Error("Google Identity Services script not loaded")
  }
  return g
}

// --- Component ---

export interface GoogleDrivePickerField {
  readonly state: { readonly value: string }
  readonly handleChange: (value: string) => void
}

interface GoogleDrivePickerProps {
  readonly field: GoogleDrivePickerField
  readonly label: string
  readonly description?: string
  readonly autoFocus?: boolean
  readonly readOnly?: boolean
  readonly clientId?: string
  readonly appId?: string
  readonly developerKey?: string
  readonly generatePdf?: { readonly documentStore: string }
  readonly hint?: string
  readonly stepPath?: string
  readonly requestUploadUrl: (input: {
    readonly stepPath: string
    readonly documentStore: string
    readonly contentType: string
    readonly filename: string
  }) => Promise<{ readonly fileId: string; readonly uploadUrl: string }>
  readonly requestDownloadUrl: (input: {
    readonly stepPath: string
    readonly documentStore: string
    readonly fileId: string
  }) => Promise<{ readonly downloadUrl: string }>
  readonly deleteFile: (fileId: string) => Promise<void>
}

const parsePickerValue = (
  value: string,
):
  | { fileId?: string; filename?: string; name?: string; url?: string }
  | undefined => {
  try {
    return JSON.parse(value) as {
      filename?: string
      fileId?: string
      name?: string
      url?: string
    }
  } catch {
    return undefined
  }
}

const selectedGoogleDriveFileOpenClassName =
  "max-w-full break-all text-sm font-medium text-primary underline hover:text-primary/80 disabled:opacity-50"

export type SelectedGoogleDriveFileProps =
  | {
      readonly kind: "editable"
      readonly fileName: string
    }
  | {
      readonly kind: "link"
      readonly fileName: string
      readonly href: string
    }
  | {
      readonly kind: "stored-pdf"
      readonly fileName: string
      readonly opening: boolean
      readonly onOpen: () => void
    }

export function SelectedGoogleDriveFile(props: SelectedGoogleDriveFileProps) {
  switch (props.kind) {
    case "link":
      return (
        <a
          href={props.href}
          target="_blank"
          rel="noopener noreferrer"
          className={selectedGoogleDriveFileOpenClassName}
        >
          {props.fileName}
        </a>
      )
    case "stored-pdf":
      return (
        <button
          type="button"
          disabled={props.opening}
          onClick={props.onOpen}
          className={selectedGoogleDriveFileOpenClassName}
        >
          {props.opening ? "Opening PDF..." : props.fileName}
        </button>
      )
    case "editable":
      return (
        <div className="min-w-0 max-w-full rounded-md border border-input bg-muted p-2">
          <p className="break-all text-sm font-medium text-foreground">
            {props.fileName}
          </p>
        </div>
      )
    default: {
      const _exhaustive: never = props
      return _exhaustive
    }
  }
}

function DrivePickerElementLoader({
  onError,
  onLoaded,
}: {
  readonly onError: (message: string) => void
  readonly onLoaded: () => void
}) {
  "use no memo"

  useEffect(() => {
    loadDrivePickerElement(onLoaded, onError)
  }, [onLoaded, onError])

  return null
}

/**
 * Google Drive file picker component using @googleworkspace/drive-picker-element.
 *
 * Handles its own OAuth consent via Google Identity Services since the
 * existing login token only has profile/email scopes, not Drive.
 *
 * The OAuth bearer token is kept only in browser memory and shared between
 * remounted picker fields until shortly before it expires. generatePdf fields
 * export and upload before submission, so only the stored PDF reference enters
 * form state.
 *
 * Receives public Picker configuration from field pluginData. The server-side
 * form walker reads the runtime environment and sends those values here.
 */
export function GoogleDrivePicker({
  field,
  label,
  description,
  autoFocus,
  readOnly,
  clientId = "",
  appId = "",
  developerKey = "",
  generatePdf,
  hint,
  stepPath,
  requestUploadUrl,
  requestDownloadUrl,
  deleteFile,
}: GoogleDrivePickerProps) {
  const value = field.state.value
  // Bearer token lives only in browser memory, never form state or storage.
  const oauthTokenRef = useRef<string>("")
  const [oauthToken, setOauthToken] = useState<string>("")
  const [selectedFileName, setSelectedFileName] = useState<string>("")
  const [selectedFileUrl, setSelectedFileUrl] = useState<string>("")
  const [showPicker, setShowPicker] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [componentLoaded, setComponentLoaded] = useState(false)
  const [authenticating, setAuthenticating] = useState(false)
  const [exportingPdf, setExportingPdf] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const labelId = useId()
  const handleComponentLoaded = useCallback(() => setComponentLoaded(true), [])

  useEffect(() => {
    for (const message of googleDrivePickerConfigurationDiagnostics({
      clientId,
      appId,
      developerKey,
    })) {
      console.warn(message)
    }
  }, [clientId, appId, developerKey])

  // Parse existing value to show file name and URL
  useEffect(() => {
    if (value) {
      const parsed = parsePickerValue(value)
      setSelectedFileName(parsed?.name ?? parsed?.filename ?? "")
      setSelectedFileUrl(parsed?.url ?? "")
    } else {
      setSelectedFileName("")
      setSelectedFileUrl("")
    }
  }, [value])

  // Radix modal dialogs set pointer-events: none on document.body to
  // prevent outside interactions.  The Google Drive picker overlay is
  // appended to body by Google, so it inherits this and becomes
  // unclickable.  Temporarily restore pointer-events while the picker
  // is open so users can select files.
  useEffect(() => {
    if (!showPicker) return
    const prev = document.body.style.pointerEvents
    document.body.style.pointerEvents = "auto"
    return () => {
      // Only restore if still "auto" — avoids clobbering another modal
      // that may have set pointer-events in the meantime.
      if (document.body.style.pointerEvents === "auto") {
        document.body.style.pointerEvents = prev
      }
    }
  }, [showPicker])

  // Shared handler for when we receive a token from GIS.
  const handleTokenResponse = useCallback(
    (response: TokenResponse) => {
      setAuthenticating(false)
      if (response.access_token) {
        setError(null)
        oauthTokenRef.current = response.access_token
        setOauthToken(response.access_token)
        setShowPicker(true)
        if (response.expires_in) {
          setCachedPickerToken({
            clientId,
            token: response.access_token,
            expiresInSeconds: response.expires_in,
          })
        }
      }
    },
    [clientId],
  )

  // Handle OAuth token acquisition via Google Identity Services
  const handleAuthClick = useCallback(() => {
    if (readOnly || authenticating || exportingPdf) return

    // Clear recoverable errors so the user can retry without a full reload.
    setError(null)

    if (generatePdf && !stepPath) {
      setError("Cannot upload exported PDF: missing form step context.")
      return
    }

    // Dynamic forms can remount fields after every change. The expiry-aware
    // page cache is the source of truth for all repeated selections.
    const cachedToken = getCachedPickerToken({ clientId })
    if (cachedToken) {
      oauthTokenRef.current = cachedToken
      setOauthToken(cachedToken)
      setShowPicker(true)
      return
    }

    oauthTokenRef.current = ""
    setOauthToken("")

    let gis: Google
    try {
      gis = getGIS()
    } catch {
      setError("Google Identity Services script not loaded yet. Please retry.")
      return
    }
    setAuthenticating(true)
    requestGoogleDriveAccessToken({
      google: gis,
      clientId,
      ...(hint !== undefined && hint !== "" && { hint }),
      onResponse: handleTokenResponse,
      onError: () => {
        setAuthenticating(false)
        setError("Google Drive authorization failed. Please try again.")
      },
    })
  }, [
    clientId,
    generatePdf,
    hint,
    readOnly,
    authenticating,
    exportingPdf,
    handleTokenResponse,
    stepPath,
  ])

  // Ref callback: attaches the picker:picked listener when the <drive-picker>
  // element mounts and removes it on unmount. No deps needed — React calls
  // the callback with the element on mount and with null on unmount.
  const pickerRef = useCallback(
    (picker: HTMLElement | null) => {
      if (!picker) return

      const handlePicked = (event: Event) => {
        const detail = (event as CustomEvent).detail
        const docs = detail?.docs ?? detail
        if (!Array.isArray(docs) || docs.length === 0) return

        const file = docs[0] as {
          id: string
          name: string
          mimeType: string
          url: string
        }
        const metadata = {
          id: file.id,
          name: file.name,
          mimeType: file.mimeType,
          url: file.url,
        }

        // Without PDF export, store metadata only — no credential.
        if (!generatePdf) {
          field.handleChange(JSON.stringify(metadata))
          setSelectedFileName(file.name)
          setShowPicker(false)
          return
        }

        const token = oauthTokenRef.current
        if (!token) {
          setError(
            "Google Drive authorization expired. Please reauthorize and select the file again.",
          )
          setShowPicker(false)
          return
        }
        if (!stepPath) {
          setError("Cannot upload exported PDF: missing form step context.")
          setShowPicker(false)
          return
        }

        setExportingPdf(true)
        setError(null)
        void exportGoogleDriveFileToDocumentStore({
          file: metadata,
          accessToken: token,
          stepPath,
          documentStore: generatePdf.documentStore,
          requestUploadUrl,
          deleteFile,
        })
          .then((generatedPdf) => {
            const previousFileId = parsePickerValue(value)?.fileId
            field.handleChange(JSON.stringify(generatedPdf))
            setSelectedFileName(file.name)
            setShowPicker(false)
            if (previousFileId) {
              void deleteFile(previousFileId).catch(() => {
                setError("The previous stored PDF could not be removed.")
              })
            }
          })
          .catch((cause: unknown) => {
            if (cause instanceof GoogleDriveBrowserExportError) {
              if (
                cause.code === "drive-authorization" ||
                cause.code === "drive-access"
              ) {
                oauthTokenRef.current = ""
                setOauthToken("")
                clearPickerTokenCache()
              }
              setError(cause.message)
            } else {
              setError(
                "Failed to export and upload the selected Drive file. Please try again.",
              )
            }
            setShowPicker(false)
          })
          .finally(() => {
            setExportingPdf(false)
          })
      }

      picker.addEventListener("picker:picked", handlePicked)
      // Return cleanup — React 19 ref callbacks support cleanup returns
      return () => {
        picker.removeEventListener("picker:picked", handlePicked)
      }
    },
    [deleteFile, field, generatePdf, requestUploadUrl, stepPath, value],
  )

  const hasPickerConfiguration = Boolean(clientId && appId && developerKey)
  const busy = authenticating || exportingPdf
  const storedFileId = parsePickerValue(value)?.fileId

  const handleDownloadClick = useCallback(() => {
    if (!readOnly || !generatePdf || !storedFileId || downloading) {
      return
    }
    if (!stepPath) {
      setError("Cannot download stored PDF: missing form step context.")
      return
    }

    setDownloading(true)
    setError(null)
    void openStoredGoogleDrivePdf({
      stepPath,
      documentStore: generatePdf.documentStore,
      fileId: storedFileId,
      requestDownloadUrl,
      openUrl: (downloadUrl) => globalThis.location.assign(downloadUrl),
    })
      .catch(() => {
        setError("The stored PDF could not be opened. Please try again.")
      })
      .finally(() => {
        setDownloading(false)
      })
  }, [
    downloading,
    generatePdf,
    readOnly,
    requestDownloadUrl,
    stepPath,
    storedFileId,
  ])

  return (
    <div className="min-w-0 space-y-2">
      <DrivePickerElementLoader
        onLoaded={handleComponentLoaded}
        onError={setError}
      />
      <span
        id={labelId}
        className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
      >
        {label}
      </span>
      {description && (
        <p className="text-muted-foreground text-sm">{description}</p>
      )}
      {!hasPickerConfiguration && !readOnly ? (
        <div className="rounded-md border border-yellow-500 bg-yellow-50 p-3 text-sm text-yellow-800">
          <p className="font-medium">
            {GOOGLE_DRIVE_NOT_CONFIGURED_USER_MESSAGE}
          </p>
        </div>
      ) : (
        <div className="min-w-0 space-y-2">
          {error && (
            <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">
              {error}
            </div>
          )}
          {selectedFileName &&
            (readOnly && selectedFileUrl ? (
              <SelectedGoogleDriveFile
                kind="link"
                fileName={selectedFileName}
                href={selectedFileUrl}
              />
            ) : readOnly && storedFileId && generatePdf ? (
              <SelectedGoogleDriveFile
                kind="stored-pdf"
                fileName={selectedFileName}
                opening={downloading}
                onOpen={handleDownloadClick}
              />
            ) : (
              <SelectedGoogleDriveFile
                kind="editable"
                fileName={selectedFileName}
              />
            ))}
          {!readOnly && !componentLoaded && (
            <p className="text-muted-foreground text-sm">
              Loading Google Drive picker...
            </p>
          )}
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {/* Keep actions available when error is set so users can retry
                without a full page reload. Only missing Picker configuration
                hard-block the control surface above. */}
            {!readOnly && componentLoaded && (
              <>
                <button
                  type="button"
                  disabled={busy}
                  aria-labelledby={labelId}
                  className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 border border-input bg-background hover:bg-accent hover:text-accent-foreground h-10 px-4 py-2"
                  onClick={handleAuthClick}
                  // biome-ignore lint/a11y/noAutofocus: form walker manages focus for first interactive field
                  autoFocus={autoFocus}
                >
                  {authenticating
                    ? "Authenticating..."
                    : exportingPdf
                      ? "Exporting PDF..."
                      : selectedFileName
                        ? "Change file"
                        : error
                          ? "Try again"
                          : "Select file"}
                </button>
                {selectedFileName && (
                  <button
                    type="button"
                    className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 border border-input bg-background hover:bg-accent hover:text-accent-foreground h-10 px-4 py-2"
                    onClick={() => {
                      const fileId = parsePickerValue(value)?.fileId
                      if (fileId) {
                        void deleteFile(fileId).catch(() => {
                          setError("The stored PDF could not be removed.")
                        })
                      }
                      setSelectedFileName("")
                      setError(null)
                      field.handleChange("")
                    }}
                  >
                    Remove
                  </button>
                )}
              </>
            )}
          </div>
          {/* Only render picker when we want to show it */}
          {!readOnly && showPicker && oauthToken && (
            <drive-picker
              ref={pickerRef}
              app-id={appId}
              client-id={clientId}
              developer-key={developerKey}
              oauth-token={oauthToken}
            >
              <drive-picker-docs-view
                include-folders="false"
                {...(generatePdf && {
                  "mime-types": GOOGLE_DRIVE_PDF_MIME_TYPES.join(","),
                })}
              />
            </drive-picker>
          )}
        </div>
      )}
    </div>
  )
}
