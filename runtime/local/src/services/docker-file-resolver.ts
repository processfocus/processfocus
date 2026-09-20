import { FileResolutionHost } from "@processfocus/runtime"
import { Effect, Layer } from "effect"

export const LocalFileResolutionHostLive = Layer.succeed(FileResolutionHost, {
  resolveDownloadUrl: ({ fileId, storePrefix }) =>
    Effect.succeed(`file:///pf/document-store/${storePrefix}/${fileId}`),
})
