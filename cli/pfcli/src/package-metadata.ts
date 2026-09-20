import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Schema } from "effect"

const PackageMetadata = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  dependencies: Schema.Record({ key: Schema.String, value: Schema.String }),
})

const packageJson: unknown = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../package.json", import.meta.url)),
    "utf8",
  ),
)
const metadata = Schema.decodeUnknownSync(PackageMetadata)(packageJson)

const requiredDependencyVersion = (packageName: string): string => {
  const version = metadata.dependencies[packageName]
  if (version === undefined) {
    throw new Error(
      `Invalid @processfocus/cli package metadata: missing ${packageName}`,
    )
  }
  return version
}

export const CLI_PACKAGE_NAME = metadata.name
export const CLI_PACKAGE_VERSION = metadata.version
export const CLI_ORGANISATION_SDK_VERSION =
  requiredDependencyVersion("processfocus")
export const CLI_ORGANISATION_RUNTIME_DEPENDENCIES = {
  "@cedar-policy/cedar-wasm": requiredDependencyVersion(
    "@cedar-policy/cedar-wasm",
  ),
  "@tursodatabase/database": requiredDependencyVersion(
    "@tursodatabase/database",
  ),
  "@tursodatabase/serverless": requiredDependencyVersion(
    "@tursodatabase/serverless",
  ),
  "@tursodatabase/sync": requiredDependencyVersion("@tursodatabase/sync"),
}
