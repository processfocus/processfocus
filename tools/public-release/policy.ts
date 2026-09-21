import type { NxReleaseConfiguration } from "nx/src/config/nx-json"

// Deliberately narrower than the source/publication boundary: #2483's first ten.
export const RELEASE_PACKAGES: readonly string[] = [
  "processfocus",
  "@processfocus/runtime",
  "@processfocus/runtime-local",
  "@processfocus/cli",
  "@processfocus/hosting-contract",
  "@processfocus/plugin-aws-lambda",
  "@processfocus/plugin-docker",
  "@processfocus/plugin-google-drive",
  "@processfocus/plugin-posthog",
  "@processfocus/plugin-resend",
]

export const RELEASE_VERSION = "0.1.0-next.0"
export const RELEASE_TAG = "next"
export const releaseConfiguration = {
  groups: {
    public: {
      projects: [...RELEASE_PACKAGES],
      projectsRelationship: "fixed",
    },
  },
  version: {
    currentVersionResolver: "disk",
    versionPrefix: "",
    updateDependents: "never",
    // Source-only implementation dependencies are bundled by pack-check. They
    // must not be promoted into the release group to version a source manifest.
    preserveLocalDependencyProtocols: true,
    git: { commit: false, tag: false, push: false },
  },
  changelog: { workspaceChangelog: false, projectChangelogs: false },
} satisfies NxReleaseConfiguration

export const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const parseManifest = (content: string): Record<string, unknown> => {
  const value: unknown = JSON.parse(content)
  if (!record(value)) throw new Error("Expected a manifest object")
  return value
}

/** Validate the actual packed manifest, not just its source counterpart. */
export const assertReleaseManifest = (
  manifest: Record<string, unknown>,
  expectedName: string,
): void => {
  if (
    !RELEASE_PACKAGES.includes(expectedName) ||
    manifest["name"] !== expectedName ||
    manifest["version"] !== RELEASE_VERSION ||
    manifest["private"] === true
  )
    throw new Error(`Not an initial release package: ${expectedName}`)
  const config = manifest["publishConfig"]
  if (
    !record(config) ||
    config["access"] !== "public" ||
    config["tag"] !== RELEASE_TAG
  )
    throw new Error(
      `Invalid public/next publish configuration: ${expectedName}`,
    )
  if (manifest["license"] !== "SEE LICENSE IN LICENSE.md")
    throw new Error(`Missing canonical license: ${expectedName}`)
  if (JSON.stringify(manifest).includes("workspace:"))
    throw new Error(`Packed workspace reference: ${expectedName}`)
  for (const section of [
    "dependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    const dependencies = manifest[section]
    if (dependencies === undefined) continue
    if (!record(dependencies)) throw new Error(`Invalid ${section}`)
    for (const [name, version] of Object.entries(dependencies)) {
      if (
        typeof version !== "string" ||
        /^(?:file:|link:|workspace:)/.test(version) ||
        name.startsWith("@pf/") ||
        ((name === "processfocus" || name.startsWith("@processfocus/")) &&
          (!RELEASE_PACKAGES.includes(name) || version !== RELEASE_VERSION))
      )
        throw new Error(`Unreleasable dependency ${expectedName} -> ${name}`)
    }
  }
}
