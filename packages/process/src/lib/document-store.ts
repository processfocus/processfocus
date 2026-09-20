import type { IConstruct } from "constructs"
import { Construct } from "constructs"

const DEFAULT_MAX_FILE_SIZE = 100 * 1024 * 1024 // 100MB

export interface DocumentStoreProps {
  readonly acceptedTypes?: readonly string[]
  readonly maxFileSize?: number // bytes, default 100MB
  readonly expirationDays?: number // undefined = no expiry, otherwise delete after N days
}

/**
 * A document store for file uploads and downloads.
 *
 * Attach this to an Organisation to enable presigned URL-based file
 * operations. The runtime provides the actual storage implementation
 * (local filesystem or S3).
 *
 * @example
 * ```typescript
 * new DocumentStore(org, "document-store", {
 *   acceptedTypes: ["application/zip"],
 *   maxFileSize: 50 * 1024 * 1024, // 50MB
 *   expirationDays: 3, // Delete files after 3 days
 * })
 * ```
 */
export class DocumentStore extends Construct {
  readonly acceptedTypes: readonly string[]
  readonly maxFileSize: number
  readonly expirationDays: number | undefined
  readonly isDocumentStore = true

  constructor(scope: IConstruct, id: string, props?: DocumentStoreProps) {
    super(scope, id)
    this.acceptedTypes = props?.acceptedTypes ?? []
    this.maxFileSize = props?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE
    this.expirationDays = props?.expirationDays

    if (this.expirationDays !== undefined && this.expirationDays < 1) {
      throw new Error(`DocumentStore "${id}": expirationDays must be >= 1`)
    }
  }
}
