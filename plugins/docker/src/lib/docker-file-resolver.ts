import {
  type FileResolutionError,
  type FileResolutionHost,
  resolveFileDownloadUrl,
} from "@processfocus/runtime"
import type { Effect } from "effect"

export const resolveDockerDownloadUrl = (
  fileId: string,
  storePrefix: string,
): Effect.Effect<string, FileResolutionError, FileResolutionHost> =>
  resolveFileDownloadUrl({ fileId, storePrefix })
