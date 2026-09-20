import { Data } from "effect"

export class DocumentStoreError extends Data.TaggedError("DocumentStoreError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class FileNotFoundError extends Data.TaggedError("FileNotFoundError")<{
  readonly fileId: string
}> {}
