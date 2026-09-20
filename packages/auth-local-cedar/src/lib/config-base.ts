import * as path from "node:path"
import { FileSystem } from "@effect/platform"
import { NodeFileSystem } from "@effect/platform-node"
import { Config, Context, Effect, Layer } from "effect"
import { PolicyLoadError, SchemaLoadError } from "@pf/auth-policy"
import { PolicyWatcherService, makePolicyWatcherLayer } from "./policy-watcher"

/**
 * Configuration for local Cedar authorization
 * Provides Cedar policy and schema content as text
 *
 * policiesText is an array to support merging default policies with
 * custom org-specific policies.
 */
export class LocalCedarConfig extends Context.Tag(
  "@pf/auth-local-cedar/LocalCedarConfig",
)<
  LocalCedarConfig,
  {
    readonly policiesText: readonly string[]
    readonly schemaText: string
  }
>() {}

/**
 * Resolve the path to a file within a package.
 * Uses require.resolve to find the package, then joins the relative path.
 *
 * Note: Uses indirect require.resolve via eval to prevent bundlers (Turbopack, etc.)
 * from attempting static analysis on the dynamic package name.
 */
const resolvePackagePath = (packageName: string, relativePath: string) => {
  const packagedCedarRoot = process.env["PF_CEDAR_ROOT"]
  if (packageName === "@pf/auth-policy" && packagedCedarRoot) {
    return path.join(packagedCedarRoot, path.basename(relativePath))
  }

  // Find the package.json location
  // biome-ignore lint/security/noGlobalEval: Required to hide dynamic require.resolve from bundler static analysis
  const packageJsonPath = eval(
    `require.resolve("${packageName}/package.json")`,
  ) as string
  const packageDir = path.dirname(packageJsonPath)
  return path.join(packageDir, relativePath)
}

/**
 * Default policy file path within @pf/auth-policy package
 */
export const DEFAULT_POLICIES_PATH = "cedar/policies.cedar"

/**
 * Default schema file path within @pf/auth-policy package
 */
export const DEFAULT_SCHEMA_PATH = "cedar/schema.cedarschema"

/**
 * Get the resolved path to the default policies file
 */
export const getDefaultPoliciesPath = () =>
  resolvePackagePath("@pf/auth-policy", DEFAULT_POLICIES_PATH)

/**
 * Get the resolved path to the default schema file
 */
export const getDefaultSchemaPath = () =>
  resolvePackagePath("@pf/auth-policy", DEFAULT_SCHEMA_PATH)

/**
 * Create a config layer from file paths.
 * Reads the files at layer construction time using Effect FileSystem.
 * Provides NodeFileSystem layer internally so consumers don't need to provide it.
 */
export const localCedarConfigFromPaths = (
  policiesPath: string,
  schemaPath: string,
) =>
  Layer.provide(
    Layer.effect(
      LocalCedarConfig,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem

        // Load policy and schema files with proper error types
        const policiesText = yield* fs
          .readFileString(policiesPath)
          .pipe(
            Effect.mapError(
              (cause) => new PolicyLoadError({ path: policiesPath, cause }),
            ),
          )

        const schemaText = yield* fs
          .readFileString(schemaPath)
          .pipe(
            Effect.mapError(
              (cause) => new SchemaLoadError({ path: schemaPath, cause }),
            ),
          )

        return { policiesText: [policiesText], schemaText }
      }),
    ),
    NodeFileSystem.layer,
  )

/**
 * Default configuration layer that loads policies from @pf/auth-policy package.
 * Uses path-based loading that works in all environments (bun, node, Next.js).
 *
 * Note: This is a function to avoid calling getDefaultPoliciesPath() at module load time,
 * which would fail in serverless environments where @pf/auth-policy package.json isn't available.
 */
export const LocalCedarConfigDefault = () =>
  localCedarConfigFromPaths(getDefaultPoliciesPath(), getDefaultSchemaPath())

/**
 * Configuration layer that reads Cedar policies from a directory.
 * Designed for serverless/container deployments where require.resolve doesn't work.
 *
 * Reads from:
 * - CEDAR_PATH: Directory containing *.cedar policy files and *.cedarschema files
 *
 * @example
 * // In Dockerfile:
 * // ENV CEDAR_PATH=/app/cedar
 *
 * // In code:
 * LocalCedarConfigFromEnvDir
 */
export const LocalCedarConfigFromEnvDir = Layer.provide(
  Layer.effect(
    LocalCedarConfig,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem

      const policiesDir = yield* Config.string("CEDAR_PATH")

      // List all .cedar and .cedarschema files in the directory
      const dirEntries = yield* fs.readDirectory(policiesDir)
      const cedarFiles = dirEntries.filter((entry) => entry.endsWith(".cedar"))
      const schemaFiles = dirEntries.filter((entry) =>
        entry.endsWith(".cedarschema"),
      )

      if (schemaFiles.length === 0) {
        return yield* new SchemaLoadError({
          path: policiesDir,
          cause: new Error("No .cedarschema files found in CEDAR_PATH"),
        })
      }

      // Load all policy files
      const policiesText = yield* Effect.forEach(cedarFiles, (file) => {
        const fullPath = path.join(policiesDir, file)
        return fs
          .readFileString(fullPath)
          .pipe(
            Effect.mapError(
              (cause) => new PolicyLoadError({ path: fullPath, cause }),
            ),
          )
      })

      // Load all schema files from the same directory
      const schemaTexts = yield* Effect.forEach(schemaFiles, (file) => {
        const fullPath = path.join(policiesDir, file)
        return fs
          .readFileString(fullPath)
          .pipe(
            Effect.mapError(
              (cause) => new SchemaLoadError({ path: fullPath, cause }),
            ),
          )
      })

      // Concatenate schemas: different namespaces (e.g. PF and Org) can coexist in one string
      const schemaText = schemaTexts.join("\n\n")

      return { policiesText, schemaText }
    }),
  ),
  NodeFileSystem.layer,
)

/**
 * Static configuration layer for Cedar authorization.
 * Always loads default policies from @pf/auth-policy.
 * Optionally loads additional custom policy and schema files.
 * Changes require restart to take effect.
 *
 * @param customPolicyPaths - Optional array of absolute paths to custom policy files
 * @param customSchemaPaths - Optional array of absolute paths to custom schema files
 *
 * @example
 * // Default policies only
 * LocalCedarConfigStatic()
 *
 * // With custom policies and schema
 * LocalCedarConfigStatic(["/path/to/custom.cedar"], ["/path/to/custom.cedarschema"])
 */
export const LocalCedarConfigStatic = (
  customPolicyPaths?: readonly string[],
  customSchemaPaths?: readonly string[],
) =>
  Layer.provide(
    Layer.effect(
      LocalCedarConfig,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem

        // Load default policies
        const defaultPoliciesText = yield* fs
          .readFileString(getDefaultPoliciesPath())
          .pipe(
            Effect.mapError(
              (cause) =>
                new PolicyLoadError({ path: getDefaultPoliciesPath(), cause }),
            ),
          )

        // Load default schema
        const defaultSchemaText = yield* fs
          .readFileString(getDefaultSchemaPath())
          .pipe(
            Effect.mapError(
              (cause) =>
                new SchemaLoadError({ path: getDefaultSchemaPath(), cause }),
            ),
          )

        // Load custom policies if provided
        const customPoliciesText = customPolicyPaths
          ? yield* Effect.forEach(customPolicyPaths, (policyPath) =>
              fs
                .readFileString(policyPath)
                .pipe(
                  Effect.mapError(
                    (cause) => new PolicyLoadError({ path: policyPath, cause }),
                  ),
                ),
            )
          : []

        // Load custom schema files and concatenate with default schema
        const customSchemaTexts = customSchemaPaths
          ? yield* Effect.forEach(customSchemaPaths, (schemaPath) =>
              fs
                .readFileString(schemaPath)
                .pipe(
                  Effect.mapError(
                    (cause) => new SchemaLoadError({ path: schemaPath, cause }),
                  ),
                ),
            )
          : []

        // Concatenate schemas: different namespaces (e.g. PF and Org) can coexist in one string
        const schemaText = [defaultSchemaText, ...customSchemaTexts].join(
          "\n\n",
        )

        return {
          policiesText: [defaultPoliciesText, ...customPoliciesText],
          schemaText,
        }
      }),
    ),
    NodeFileSystem.layer,
  )

/**
 * Hot-reload configuration layer for Cedar authorization.
 * Watches all policy files (default + custom) for changes and automatically reloads.
 *
 * Provides both LocalCedarConfig and PolicyWatcherService.
 * Use this when you want policy changes to take effect without restart.
 *
 * @param basePath - Base path to resolve relative custom policy file paths against
 * @param customPolicyFiles - Array of custom policy file paths relative to basePath
 * @param customSchemaFiles - Optional array of absolute paths to custom schema files
 *
 * @example
 * LocalCedarConfigHotReload("/path/to/org", ["cedar/custom.cedar"])
 */
export const LocalCedarConfigHotReload = (
  basePath: string,
  customPolicyFiles: readonly string[],
  customSchemaFiles?: readonly string[],
) => {
  // Resolve custom policy paths relative to basePath
  const resolvedCustomPaths = customPolicyFiles.map((f) =>
    require("node:path").resolve(basePath, f),
  )

  // Combine default policy path with custom paths - all will be watched
  const allPolicyPaths = [getDefaultPoliciesPath(), ...resolvedCustomPaths]

  // Create watcher for all policy files (default + custom)
  // Pass "/" as basePath since paths are already absolute
  const policyWatcherLayer = makePolicyWatcherLayer("/", allPolicyPaths)

  // Create config layer that gets policies from watcher and loads schema
  const configLayer = Layer.effect(
    LocalCedarConfig,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const watcher = yield* PolicyWatcherService
      const policiesText = yield* watcher.currentPolicies

      // Load default schema (not watched - schema changes are rare and require restart)
      const defaultSchemaText = yield* fs
        .readFileString(getDefaultSchemaPath())
        .pipe(
          Effect.mapError(
            (cause) =>
              new SchemaLoadError({ path: getDefaultSchemaPath(), cause }),
          ),
        )

      // Load custom schema files and concatenate with default schema
      const customSchemaTexts = customSchemaFiles
        ? yield* Effect.forEach(customSchemaFiles, (schemaPath) =>
            fs
              .readFileString(schemaPath)
              .pipe(
                Effect.mapError(
                  (cause) => new SchemaLoadError({ path: schemaPath, cause }),
                ),
              ),
          )
        : []

      // Concatenate schemas: different namespaces (e.g. PF and Org) can coexist in one string
      const schemaText = [defaultSchemaText, ...customSchemaTexts].join("\n\n")

      return { policiesText, schemaText }
    }),
  ).pipe(Layer.provide(NodeFileSystem.layer))

  // Combine: ConfigLayer needs PolicyWatcherService, and we want to provide both
  return Layer.provideMerge(
    Layer.provide(configLayer, policyWatcherLayer),
    policyWatcherLayer,
  )
}
