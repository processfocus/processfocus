"use client"

import { createContext, useContext } from "react"

/**
 * Result from requesting an upload URL from the document store.
 */
export interface UploadUrlResult {
  readonly fileId: string
  readonly uploadUrl: string
}

/**
 * Interface for the file upload service.
 * Provided by the application (e.g. via GraphQL) and consumed by FileField.
 */
export interface FileUploadService {
  readonly requestUploadUrl: (options: {
    stepPath: string
    documentStore: string
    contentType: string
    filename: string
  }) => Promise<UploadUrlResult>
  /**
   * Optional: Delete a file that was previously created but not uploaded.
   * Called when the user removes a file from the upload field.
   */
  readonly deleteFile?: (fileId: string) => Promise<void>
}

const FileUploadContext = createContext<FileUploadService | null>(null)

export const FileUploadProvider = FileUploadContext.Provider

/**
 * Access the file upload service from context.
 * Throws if not wrapped in a FileUploadProvider.
 */
export function useFileUpload(): FileUploadService {
  const service = useContext(FileUploadContext)
  if (!service) {
    throw new Error("useFileUpload must be used within a FileUploadProvider")
  }
  return service
}
