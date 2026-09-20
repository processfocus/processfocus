import { Context, Data, Effect } from "effect"

export class FileResolutionError extends Data.TaggedError(
  "FileResolutionError",
)<{
  readonly message: string
  readonly cause?: unknown
}> {}

export interface FileResolutionRequest {
  readonly fileId: string
  readonly storePrefix: string
}

/** Provider-neutral file handoff capability supplied by a runtime host. */
export class FileResolutionHost extends Context.Tag(
  "@processfocus/runtime/FileResolutionHost",
)<
  FileResolutionHost,
  {
    readonly resolveDownloadUrl: (
      request: FileResolutionRequest,
    ) => Effect.Effect<string, FileResolutionError, never>
  }
>() {}

export const resolveFileDownloadUrl = (
  request: FileResolutionRequest,
): Effect.Effect<string, FileResolutionError, FileResolutionHost> =>
  Effect.flatMap(FileResolutionHost, (resolver) =>
    resolver.resolveDownloadUrl(request),
  )
