import { notFound } from "next/navigation"
import EmbedClient from "./embed-client"
import {
  embedSegmentsFromStepPath,
  stepPathFromEmbedSegments,
} from "@/lib/embed-manifest"
import {
  getEmbedManifestEntries,
  getEmbedManifestEntryForPath,
} from "@/lib/embed-manifest-store"

const EMPTY_EMBED_SEGMENT = "__embed-placeholder__"

export function generateStaticParams() {
  const entries = getEmbedManifestEntries()
  if (entries.length === 0) {
    return [{ startStepPath: [EMPTY_EMBED_SEGMENT] }]
  }

  const paramsByPath = new Map<string, { startStepPath: string[] }>()

  for (const entry of entries) {
    for (const path of [entry.processPath, entry.stepPath]) {
      const startStepPath = embedSegmentsFromStepPath(path)
      paramsByPath.set(startStepPath.join("/"), { startStepPath })
    }
  }

  return [...paramsByPath.values()]
}

export default async function EmbedPage({
  params,
}: {
  params: Promise<{ startStepPath: string[] }>
}) {
  const { startStepPath } = await params

  if (startStepPath.length === 0) {
    notFound()
  }

  const entry = getEmbedManifestEntryForPath(
    stepPathFromEmbedSegments(startStepPath),
  )
  if (!entry) {
    notFound()
  }

  return <EmbedClient entry={entry} />
}
