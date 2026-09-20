import type { Metadata, MetadataRoute } from "next"
import type { FrontendManifest } from "./frontend-manifest"

type ManifestIconPurpose = NonNullable<
  MetadataRoute.Manifest["icons"]
>[number]["purpose"]

const normalizePurpose = (
  purpose: string | undefined,
): ManifestIconPurpose | undefined => {
  if (!purpose) {
    return undefined
  }

  const tokens = purpose.split(" ").filter((token) => token.length > 0)
  if (
    tokens.length > 0 &&
    tokens.every(
      (token) =>
        token === "any" || token === "maskable" || token === "monochrome",
    )
  ) {
    return tokens.join(" ") as ManifestIconPurpose
  }

  return undefined
}

export const buildAppIconMetadata = (manifest: FrontendManifest): Metadata => {
  const iconEntries = manifest.appIcons.metadata.map((icon) => ({
    url: icon.url,
    rel: icon.rel,
    type: icon.type,
    sizes: icon.sizes,
  }))

  if (iconEntries.length === 0) {
    return {}
  }

  return {
    icons: {
      icon: iconEntries.filter((icon) => icon.rel === "icon"),
      other: iconEntries.filter((icon) => icon.rel !== "icon"),
    },
  }
}

export const buildWebAppManifest = (
  manifest: FrontendManifest,
): MetadataRoute.Manifest => {
  const icons = manifest.appIcons.manifest.map((icon) => ({
    src: icon.src,
    sizes: icon.sizes,
    type: icon.type,
    purpose: normalizePurpose(icon.purpose),
  }))

  return {
    name: manifest.organisation.name,
    ...(manifest.organisation.acronym !== undefined
      ? { short_name: manifest.organisation.acronym }
      : {}),
    ...(icons.length > 0 ? { icons } : {}),
  }
}
