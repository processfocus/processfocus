"use client"

import type { StandardSchemaV1Issue } from "@tanstack/react-form"
import { useCallback, useRef, useState } from "react"
import { useFileUpload } from "./file-upload-context"
import { useFieldContext, useFormContext } from "./form-context"
import { Button } from "./ui/button"
import { Field, FieldDescription, FieldError, FieldLabel } from "./ui/field"
import { cn } from "./utils/utils"

type UploadStatus = "idle" | "requesting" | "uploading" | "done" | "error"

const contentTypeFor = (file: File): string => {
  if (file.type) {
    return file.type
  }
  return "application/octet-stream"
}

const uploadFile = (
  file: File,
  uploadUrl: string,
  contentType: string,
  onProgress: (progress: number) => void,
): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100))
      }
    })
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve()
        return
      }
      reject(new Error(`Upload failed with status ${xhr.status}`))
    })
    xhr.addEventListener("error", () => reject(new Error("Upload failed")))
    xhr.open("PUT", uploadUrl)
    xhr.setRequestHeader("Content-Type", contentType)
    xhr.send(file)
  })

const uploadErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }
  return "Upload failed"
}

export function FileField({
  label,
  descriptionHtml,
  accept,
  maxSize,
  readOnly,
  documentStore,
  stepPath,
}: {
  label: string
  descriptionHtml?: string | undefined | null
  accept?: string
  maxSize?: number
  readOnly?: boolean
  documentStore: string
  stepPath: string
}) {
  const field = useFieldContext<string>()
  const form = useFormContext()
  const fileUpload = useFileUpload()
  const inputRef = useRef<HTMLInputElement>(null)

  const [status, setStatus] = useState<UploadStatus>(
    field.state.value ? "done" : "idle",
  )
  const [fileName, setFileName] = useState<string>("")
  const [progress, setProgress] = useState(0)
  const [uploadError, setUploadError] = useState<string>("")

  const validationErrors = field.state.meta
    .errors as unknown as StandardSchemaV1Issue[]
  const serverError = field.state.meta.errorMap?.onSubmit
  const allErrors: Array<{ message?: string }> = [
    ...validationErrors,
    ...(serverError ? [{ message: serverError as string }] : []),
    ...(uploadError ? [{ message: uploadError }] : []),
  ]
  const { isTouched, isDefaultValue } = field.state.meta
  const afterSubmission = form.state.submissionAttempts > 0
  const isInvalid =
    (afterSubmission && allErrors.length > 0) ||
    (isTouched && !isDefaultValue && allErrors.length > 0) ||
    uploadError.length > 0
  const errorId = `${field.name}-error`

  const handleFileSelect = useCallback(
    (file: File) => {
      setUploadError("")
      setFileName(file.name)

      // Client-side size validation
      if (maxSize != null && file.size > maxSize) {
        const maxMB = (maxSize / 1_000_000).toFixed(0)
        setUploadError(`File exceeds maximum size of ${maxMB} MB`)
        setStatus("error")
        return
      }

      const contentType = contentTypeFor(file)

      // Step 1: Request upload URL
      setStatus("requesting")
      setProgress(0)
      fileUpload
        .requestUploadUrl({
          stepPath,
          documentStore,
          contentType,
          filename: file.name,
        })
        .then(({ fileId, uploadUrl }) => {
          // Step 2: Upload file
          setStatus("uploading")
          return uploadFile(file, uploadUrl, contentType, setProgress).then(
            () => {
              // Step 3: Set the fileId on the form field
              setStatus("done")
              setProgress(100)
              field.handleChange(fileId)
            },
          )
        })
        .catch((error) => {
          setUploadError(uploadErrorMessage(error))
          setStatus("error")
        })
    },
    [fileUpload, field, maxSize, documentStore, stepPath],
  )

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (file) {
        handleFileSelect(file)
      }
    },
    [handleFileSelect],
  )

  const handleChooseFile = useCallback(() => {
    inputRef.current?.click()
  }, [])

  const handleRemove = useCallback(() => {
    const currentFileId = field.state.value
    if (currentFileId && fileUpload.deleteFile) {
      fileUpload.deleteFile(currentFileId).catch((error) => {
        console.warn("deleteFile failed:", error)
      })
    }
    setStatus("idle")
    setFileName("")
    setProgress(0)
    setUploadError("")
    field.handleChange("")
    // Reset the file input so the same file can be re-selected
    if (inputRef.current) {
      inputRef.current.value = ""
    }
  }, [field, fileUpload])

  const isUploading = status === "requesting" || status === "uploading"

  return (
    <Field>
      <FieldLabel htmlFor={field.name}>{label}</FieldLabel>

      {/* Hidden native file input */}
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        onChange={handleInputChange}
        {...(accept != null && { accept })}
        tabIndex={-1}
      />

      {/* Upload area */}
      {status === "idle" && (
        <Button
          type="button"
          variant="outline"
          onClick={handleChooseFile}
          disabled={readOnly}
          className="w-full justify-start"
          aria-invalid={isInvalid}
          aria-describedby={isInvalid ? errorId : undefined}
        >
          <svg
            className="mr-2 h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 16V4m0 0l-4 4m4-4l4 4M4 20h16"
            />
          </svg>
          Choose file...
        </Button>
      )}

      {/* Uploading state */}
      {isUploading && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm">
            <svg
              className="h-4 w-4 animate-spin text-muted-foreground"
              fill="none"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
            <span className="truncate text-muted-foreground">
              {status === "requesting"
                ? "Preparing upload..."
                : `Uploading ${fileName}`}
            </span>
          </div>
          {status === "uploading" && (
            <div className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
              <div
                className={cn(
                  "bg-primary h-full rounded-full transition-[width] duration-200",
                )}
                style={{ width: `${progress}%` }}
              />
            </div>
          )}
        </div>
      )}

      {/* Done / Error state with filename */}
      {(status === "done" || status === "error") && (
        <div className="flex items-center gap-2">
          {status === "done" && (
            <svg
              className="h-4 w-4 shrink-0 text-green-500"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M5 13l4 4L19 7"
              />
            </svg>
          )}
          {status === "error" && (
            <svg
              className="h-4 w-4 shrink-0 text-destructive"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 9v4m0 4h.01M12 2a10 10 0 100 20 10 10 0 000-20z"
              />
            </svg>
          )}
          <span className="min-w-0 flex-1 truncate text-sm">
            {fileName || field.state.value}
          </span>
          {!readOnly && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleRemove}
              className="h-auto shrink-0 px-2 py-1 text-xs"
            >
              Remove
            </Button>
          )}
        </div>
      )}

      {isInvalid && allErrors.length > 0 && (
        <FieldError errors={allErrors} id={errorId} />
      )}
      {descriptionHtml && <FieldDescription trustedHtml={descriptionHtml} />}
    </Field>
  )
}
