import type { MetadataRoute } from "next"
import { buildWebAppManifest } from "@/lib/app-icons-metadata"
import { getFrontendManifest } from "@/lib/frontend-manifest-store"

export default function manifest(): MetadataRoute.Manifest {
  return buildWebAppManifest(getFrontendManifest())
}
