"use client"

import { type ReactNode, useCallback, useMemo } from "react"
import {
  FileUploadProvider as BaseFileUploadProvider,
  type FileUploadService,
} from "@pf/shadcn-components"
import { useGraphqlClient } from "./client-provider"

interface UploadUrlResponse {
  requestUploadUrl: {
    fileId: string
    uploadUrl: string
    expiresAt: string
  }
}

const REQUEST_UPLOAD_URL_MUTATION = `
  mutation RequestUploadUrl($stepPath: String!, $documentStore: String!, $contentType: String, $filename: String) {
    requestUploadUrl(stepPath: $stepPath, documentStore: $documentStore, contentType: $contentType, filename: $filename) {
      fileId
      uploadUrl
      expiresAt
    }
  }
`

const DELETE_FILE_MUTATION = `
  mutation DeleteFile($fileId: ID!) {
    deleteFile(fileId: $fileId) {
      success
    }
  }
`

export function FileUploadClientProvider({
  children,
}: {
  children: ReactNode
}) {
  const graphqlClient = useGraphqlClient()

  const requestUploadUrl = useCallback(
    async (options: {
      stepPath: string
      documentStore: string
      contentType: string
      filename: string
    }) => {
      const data = await graphqlClient.request<UploadUrlResponse>(
        REQUEST_UPLOAD_URL_MUTATION,
        {
          stepPath: options.stepPath,
          documentStore: options.documentStore,
          contentType: options.contentType,
          filename: options.filename,
        },
      )
      return {
        fileId: data.requestUploadUrl.fileId,
        uploadUrl: data.requestUploadUrl.uploadUrl,
      }
    },
    [graphqlClient],
  )

  const deleteFile = useCallback(
    async (fileId: string) => {
      await graphqlClient.request(DELETE_FILE_MUTATION, { fileId })
    },
    [graphqlClient],
  )

  const service = useMemo<FileUploadService>(
    () => ({ requestUploadUrl, deleteFile }),
    [requestUploadUrl, deleteFile],
  )

  return (
    <BaseFileUploadProvider value={service}>{children}</BaseFileUploadProvider>
  )
}
