import * as path from "node:path"
import { FileSystem } from "@effect/platform"
import { NodeFileSystem } from "@effect/platform-node"
import { Config, Context, Data, Effect, Layer } from "effect"
import { type Organisation, OrganisationProvider } from "@pf/process"
import { isCustomEntitiesConfig } from "./custom-entities-config"
import { isPoliciesConfig } from "./policies-config"

/**
 * Error thrown when the CEDAR_PATH directory does not exist.
 */
export class CedarPoliciesDirNotFoundError extends Data.TaggedError(
  "CedarPoliciesDirNotFoundError",
)<{
  readonly path: string
}> {
  override get message() {
    return `CEDAR_PATH directory does not exist: ${this.path}`
  }
}

/**
 * Service interface for accessing Cedar policy file paths.
 */
export interface CedarPoliciesProviderService {
  /** Absolute paths to Cedar policy files */
  readonly policyPaths: readonly string[]
  /** Absolute paths to custom Cedar schema files */
  readonly schemaPaths: readonly string[]
}

/**
 * Context tag for the CedarPoliciesProvider service.
 */
export class CedarPoliciesProvider extends Context.Tag(
  "@pf/auth-config/CedarPoliciesProvider",
)<CedarPoliciesProvider, CedarPoliciesProviderService>() {}

/**
 * Extract policy files from all PoliciesConfig children in the organisation.
 *
 * An organisation may have multiple PoliciesConfig constructs, each specifying
 * different policy files. This function collects all policy files from all
 * PoliciesConfig children.
 *
 * Used by:
 * - `pfcli build` to copy policy files to dist/cedar/
 * - OrgCedarPoliciesProvider to get relative paths for resolution
 *
 * @returns Relative policy file paths from all PoliciesConfig children, or empty array if none
 */
export const extractPolicyFiles = (org: Organisation): ReadonlyArray<string> =>
  org.node.children.flatMap((child) =>
    isPoliciesConfig(child) ? [...child.policyFiles] : [],
  )

/**
 * Extract schema files from all CustomEntitiesConfig children in the organisation.
 *
 * An organisation may have multiple CustomEntitiesConfig constructs, each specifying
 * different schema files. This function collects all schema files from all
 * CustomEntitiesConfig children.
 *
 * Used by:
 * - `pfcli build` to copy schema files to dist/cedar/
 * - OrgCedarPoliciesProvider to get relative paths for resolution
 *
 * @returns Relative schema file paths from all CustomEntitiesConfig children, or empty array if none
 */
export const extractSchemaFiles = (org: Organisation): ReadonlyArray<string> =>
  org.node.children.flatMap((child) =>
    isCustomEntitiesConfig(child) ? [...child.schemaFiles] : [],
  )

/**
 * Layer that provides CedarPoliciesProvider by reading policy files from
 * the CEDAR_PATH environment variable.
 *
 * Designed for serverless/container deployments (e.g., AWS Lambda).
 * Lists all .cedar files in the directory and returns their absolute paths.
 *
 * Requires:
 * - CEDAR_PATH environment variable to be set
 *
 * @example
 * ```typescript
 * // In Dockerfile:
 * // ENV CEDAR_PATH=/app/cedar
 *
 * // In code:
 * const layer = StaticCedarPoliciesProvider
 * ```
 */
export const StaticCedarPoliciesProvider = Layer.effect(
  CedarPoliciesProvider,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    const policiesDir = yield* Config.string("CEDAR_PATH")

    // Validate directory exists before reading
    const exists = yield* fs.exists(policiesDir)
    if (!exists) {
      return yield* new CedarPoliciesDirNotFoundError({ path: policiesDir })
    }

    // List all .cedar files in the directory
    const dirEntries = yield* fs.readDirectory(policiesDir)
    const cedarFiles = dirEntries.filter((entry) => entry.endsWith(".cedar"))
    const schemaFiles = dirEntries.filter((entry) =>
      entry.endsWith(".cedarschema"),
    )

    // Return absolute paths
    const policyPaths = cedarFiles.map((file) => path.join(policiesDir, file))
    const schemaPaths = schemaFiles.map((file) => path.join(policiesDir, file))

    return { policyPaths, schemaPaths }
  }),
).pipe(Layer.provide(NodeFileSystem.layer))

/**
 * Create a Layer that provides CedarPoliciesProvider by reading policy files
 * from the organisation via OrganisationProvider.
 *
 * Designed for local development with hot-reload support.
 * Uses extractPolicyFiles to get relative paths from the org's PoliciesConfig,
 * then resolves them to absolute paths using the orgPath from OrganisationProvider.
 *
 * Requires:
 * - OrganisationProvider to be provided
 *
 * @example
 * ```typescript
 * const layer = OrgCedarPoliciesProvider.pipe(
 *   Layer.provide(OrganisationProviderFromPath("./examples/demo"))
 * )
 * ```
 */
export const OrgCedarPoliciesProvider: Layer.Layer<
  CedarPoliciesProvider,
  never,
  OrganisationProvider
> = Layer.effect(
  CedarPoliciesProvider,
  Effect.gen(function* () {
    const orgProvider = yield* OrganisationProvider

    const policyFiles = extractPolicyFiles(orgProvider.organisation)
    const policyPaths = policyFiles.map((f) =>
      path.join(orgProvider.orgPath, f),
    )

    const schemaFiles = extractSchemaFiles(orgProvider.organisation)
    const schemaPaths = schemaFiles.map((f) =>
      path.join(orgProvider.orgPath, f),
    )

    return { policyPaths, schemaPaths }
  }),
)
