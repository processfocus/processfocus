import * as path from "node:path"
import { FileSystem } from "@effect/platform"
import type { PlatformError } from "@effect/platform/Error"
import {
  RUNTIME_ARTIFACT_FORMAT,
  RUNTIME_ARTIFACT_VERSION,
  Runtime,
  type ServerPluginRegistration,
  parseServerPluginRegistrations,
} from "@processfocus/runtime"
import { Config, Context, Data, Effect, Either, Layer } from "effect"
import type { Organisation } from "./organisation"
import { Organisation as OrganisationClass } from "./organisation"

/**
 * Type for custom database layers exported by organisations.
 * Uses unknown for R/E/A since we can't know the exact types at compile time.
 */
export type CustomDbLayer = Layer.Layer<unknown, unknown, unknown>
export type CustomJobLayer = Layer.Layer<unknown, unknown, unknown>

export type CustomGraphqlResolvers = Record<string, Record<string, unknown>>

export interface CustomGraphqlSchemaDefinition {
  readonly typeDefs?: string
  readonly resolvers?: CustomGraphqlResolvers
}

/**
 * Error thrown when organisation loading fails.
 */
export class OrganisationLoadError extends Data.TaggedError(
  "@pf/OrganisationLoadError",
)<{
  readonly message: string
  readonly orgPath: string
  readonly cause?: unknown
}> {}

/**
 * Service interface for accessing the loaded organisation and its metadata.
 */
export interface OrganisationProviderService {
  /** The loaded organisation instance */
  readonly organisation: Organisation
  /** Resolved absolute path to the org package root */
  readonly orgPath: string
  /** Absolute path to org.graphql schema file */
  readonly schemaPath: string
  /**
   * Optional custom database layer exported by the organisation.
   * If the org exports `CustomDbLayer`, it will be captured here.
   */
  readonly customDbLayer?: CustomDbLayer
  /**
   * Optional custom GraphQL schema/resolvers exported by the organisation.
   */
  readonly customGraphqlSchema?: CustomGraphqlSchemaDefinition
  /**
   * Optional custom job-worker layer exported by the organisation.
   * Use this for org-specific runtime services such as email senders.
   */
  readonly customJobLayer?: CustomJobLayer
  /** Versioned server plugin registrations exported by the organisation. */
  readonly serverPlugins?: readonly ServerPluginRegistration[]
}

/**
 * Context tag for the OrganisationProvider service.
 */
export class OrganisationProvider extends Context.Tag(
  "@pf/process/OrganisationProvider",
)<OrganisationProvider, OrganisationProviderService>() {}

/**
 * Dynamically load an organisation from a path.
 *
 * Loading logic:
 * 1. If `${orgPath}/org.js` exists → import bundled org
 * 2. Otherwise → import `${orgPath}/src/index.ts` (source)
 *
 * Also captures `CustomDbLayer`, `CustomGraphqlSchema`, and `CustomJobLayer`
 * if exported by the module.
 */
const loadOrganisationFromPathMechanics = (
  orgPath: string,
): Effect.Effect<
  {
    org: Organisation
    resolvedPath: string
    customDbLayer?: CustomDbLayer
    customGraphqlSchema?: CustomGraphqlSchemaDefinition
    customJobLayer?: CustomJobLayer
    serverPlugins: readonly ServerPluginRegistration[]
  },
  OrganisationLoadError | PlatformError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    // Resolve to absolute path
    const absoluteOrgPath = path.resolve(process.cwd(), orgPath)

    // Check for bundled org.js first (async)
    const bundledPath = path.join(absoluteOrgPath, "org.js")
    const sourcePath = path.join(absoluteOrgPath, "src/index.ts")

    const bundledExists = yield* fs.exists(bundledPath)
    const importPath = bundledExists ? bundledPath : sourcePath

    // Verify the import path exists before attempting dynamic import
    const importPathExists = yield* fs.exists(importPath)
    if (!importPathExists) {
      return yield* new OrganisationLoadError({
        message: `Failed to load organisation from ${orgPath}: Organisation file not found: ${importPath}`,
        orgPath,
      })
    }

    const module = yield* Effect.tryPromise({
      try: async () => {
        const mod = await import(importPath)
        return mod
      },
      catch: (error) =>
        new OrganisationLoadError({
          message: `Failed to load organisation from ${orgPath}: ${error instanceof Error ? error.message : String(error)}`,
          orgPath,
          cause: error,
        }),
    })

    const artifact = yield* Runtime.loadArtifact(
      Effect.succeed({
        format: RUNTIME_ARTIFACT_FORMAT,
        version: RUNTIME_ARTIFACT_VERSION,
        organisation: module.org,
      }),
    ).pipe(
      Effect.mapError(
        (error) =>
          new OrganisationLoadError({
            message: `Failed to load organisation from ${orgPath}: ${error.message}`,
            orgPath,
          }),
      ),
    )

    // Capture optional runtime exports by name from the org module
    const customDbLayer = module.CustomDbLayer as CustomDbLayer | undefined
    const customGraphqlSchema = module.CustomGraphqlSchema as
      | CustomGraphqlSchemaDefinition
      | undefined
    const customJobLayer = module.CustomJobLayer as CustomJobLayer | undefined
    const serverPlugins = yield* parseServerPluginRegistrations(
      module.ServerPlugins,
    ).pipe(
      Effect.mapError(
        (error) =>
          new OrganisationLoadError({
            message: `Failed to load organisation from ${orgPath}: ${error.message}`,
            orgPath,
            cause: error,
          }),
      ),
    )

    return {
      org: artifact.organisation as Organisation,
      resolvedPath: absoluteOrgPath,
      ...(customDbLayer ? { customDbLayer } : {}),
      ...(customGraphqlSchema ? { customGraphqlSchema } : {}),
      ...(customJobLayer ? { customJobLayer } : {}),
      serverPlugins,
    }
  })

const loadOrganisationFromPath = (orgPath: string) =>
  Runtime.loadOrganisation({ load: loadOrganisationFromPathMechanics }, orgPath)

/**
 * Create an OrganisationProviderService from a loaded organisation (async).
 */
interface MakeServiceOptions {
  readonly org: Organisation
  readonly orgPath: string
  readonly customDbLayer?: CustomDbLayer | undefined
  readonly customGraphqlSchema?: CustomGraphqlSchemaDefinition | undefined
  readonly customJobLayer?: CustomJobLayer | undefined
  readonly serverPlugins?: readonly ServerPluginRegistration[] | undefined
}

const makeService = ({
  org,
  orgPath,
  customDbLayer,
  customGraphqlSchema,
  customJobLayer,
  serverPlugins = [],
}: MakeServiceOptions): Effect.Effect<
  OrganisationProviderService,
  PlatformError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    // Schema path: check for dist schema first (from pfcli build), then source
    const distSchemaPath = path.join(orgPath, "dist/graphql/org.graphql")
    const localSchemaPath = path.join(orgPath, "graphql/org.graphql")
    const distSchemaExists = yield* fs.exists(distSchemaPath)
    const schemaPath = distSchemaExists ? distSchemaPath : localSchemaPath

    return {
      organisation: org,
      orgPath,
      schemaPath,
      ...(customDbLayer ? { customDbLayer } : {}),
      ...(customGraphqlSchema ? { customGraphqlSchema } : {}),
      ...(customJobLayer ? { customJobLayer } : {}),
      serverPlugins,
    }
  })

/**
 * Create an OrganisationProviderService from a loaded organisation (sync, for tests).
 */
interface MakeServiceSyncOptions
  extends Omit<MakeServiceOptions, "customDbLayer"> {
  readonly schemaPath?: string | undefined
}

const makeServiceSync = ({
  org,
  orgPath,
  schemaPath,
  customGraphqlSchema,
  customJobLayer,
  serverPlugins = [],
}: MakeServiceSyncOptions): OrganisationProviderService => {
  // For test usage, default to dist schema path or use provided path
  const resolvedSchemaPath =
    schemaPath ?? path.join(orgPath, "dist/graphql/org.graphql")

  return {
    organisation: org,
    orgPath,
    schemaPath: resolvedSchemaPath,
    ...(customGraphqlSchema ? { customGraphqlSchema } : {}),
    ...(customJobLayer ? { customJobLayer } : {}),
    serverPlugins,
  }
}

interface LogLoadedOrganisationOptions
  extends Pick<
    MakeServiceOptions,
    "customDbLayer" | "customJobLayer" | "serverPlugins"
  > {
  readonly name: string
}

const logLoadedOrganisation = ({
  name,
  customDbLayer,
  customJobLayer,
  serverPlugins = [],
}: LogLoadedOrganisationOptions) =>
  Effect.gen(function* () {
    yield* Effect.log(`Loaded organisation: ${name}`)
    if (customDbLayer) {
      yield* Effect.log(`Loaded custom database layer from organisation`)
    }
    if (customJobLayer) {
      yield* Effect.log(`Loaded custom job layer from organisation`)
    }
    if (serverPlugins.length > 0) {
      yield* Effect.log(
        `Loaded ${serverPlugins.length} server plugin registration(s) from organisation`,
      )
    }
  })

/**
 * Layer that loads organisation from `PF_ORG` environment variable.
 * Requires FileSystem.FileSystem to be provided.
 *
 * @throws OrganisationLoadError when:
 *   - PF_ORG environment variable is not set
 *   - PF_ORG path doesn't exist or doesn't contain org.js or src/index.ts
 *   - The module doesn't export an 'org' named export of type Organisation
 *   - The imported module has runtime errors during evaluation
 *
 * @example
 * ```ts
 * import { NodeFileSystem } from "@effect/platform-node"
 *
 * // Set environment variable
 * process.env.PF_ORG = "./examples/demo"
 *
 * // Provide FileSystem and use in layer composition
 * const OrgLayer = OrganisationProviderFromEnv.pipe(
 *   Layer.provide(NodeFileSystem.layer),
 * )
 * ```
 *
 * Debugging tips:
 * - Check logs for "Loading organisation from:" message to verify the path
 * - Ensure org module exports `org` as a named export: `export const org = ...`
 * - For bundled orgs, verify org.js exists in the org directory
 * - For source orgs, verify src/index.ts exists and is valid TypeScript
 */
export const OrganisationProviderFromEnv: Layer.Layer<
  OrganisationProvider,
  OrganisationLoadError | PlatformError,
  FileSystem.FileSystem
> = Layer.effect(
  OrganisationProvider,
  Effect.gen(function* () {
    const orgPath = yield* Config.string("PF_ORG").pipe(
      Effect.mapError(
        () =>
          new OrganisationLoadError({
            message: "PF_ORG environment variable is not set",
            orgPath: "<env>",
          }),
      ),
    )

    yield* Effect.log(`Loading organisation from: ${orgPath}`)

    const {
      org,
      resolvedPath,
      customDbLayer,
      customGraphqlSchema,
      customJobLayer,
      serverPlugins,
    } = yield* loadOrganisationFromPath(orgPath)

    yield* logLoadedOrganisation({
      name: org.name,
      customDbLayer,
      customJobLayer,
      serverPlugins,
    })

    return yield* makeService({
      org,
      orgPath: resolvedPath,
      customDbLayer,
      customGraphqlSchema,
      customJobLayer,
      serverPlugins,
    })
  }),
)

/**
 * Layer that loads organisation from an explicit path.
 * Requires FileSystem.FileSystem to be provided.
 *
 * @param orgPath - Path to the organisation package (relative or absolute)
 *
 * @throws OrganisationLoadError when:
 *   - orgPath doesn't exist or doesn't contain org.js or src/index.ts
 *   - The module doesn't export an 'org' named export of type Organisation
 *   - The imported module has runtime errors during evaluation
 *
 * @example
 * ```ts
 * import { NodeFileSystem } from "@effect/platform-node"
 *
 * const OrgLayer = OrganisationProviderFromPath("./examples/demo").pipe(
 *   Layer.provide(NodeFileSystem.layer),
 * )
 * ```
 */
export const OrganisationProviderFromPath = (
  orgPath: string,
): Layer.Layer<
  OrganisationProvider,
  OrganisationLoadError | PlatformError,
  FileSystem.FileSystem
> =>
  Layer.effect(
    OrganisationProvider,
    Effect.gen(function* () {
      yield* Effect.log(`Loading organisation from: ${orgPath}`)

      const {
        org,
        resolvedPath,
        customDbLayer,
        customGraphqlSchema,
        customJobLayer,
        serverPlugins,
      } = yield* loadOrganisationFromPath(orgPath)

      yield* logLoadedOrganisation({
        name: org.name,
        customDbLayer,
        customJobLayer,
        serverPlugins,
      })

      return yield* makeService({
        org,
        orgPath: resolvedPath,
        customDbLayer,
        customGraphqlSchema,
        customJobLayer,
        serverPlugins,
      })
    }),
  )

/**
 * Layer that provides a static organisation for testing purposes.
 * Uses synchronous operations (no FileSystem requirement).
 *
 * @param org - The organisation instance
 * @param orgPath - Optional path for schema/policy resolution (defaults to cwd)
 * @param schemaPath - Optional explicit schema path
 */
export const OrganisationProviderTest = (
  org: Organisation,
  orgPath?: string,
  schemaPath?: string,
  customGraphqlSchema?: CustomGraphqlSchemaDefinition,
  customJobLayer?: CustomJobLayer,
  serverPlugins: readonly ServerPluginRegistration[] = [],
): Layer.Layer<OrganisationProvider> =>
  Layer.succeed(
    OrganisationProvider,
    makeServiceSync({
      org,
      orgPath: orgPath ?? process.cwd(),
      schemaPath,
      customGraphqlSchema,
      customJobLayer,
      serverPlugins,
    }),
  )

/**
 * Check if running in development mode.
 * Dev mode requires NODE_ENV to be explicitly set to "development".
 */
const isDevMode = () => process.env["NODE_ENV"] === "development"

/**
 * Layer for local development that loads organisation, using empty org on failure.
 *
 * When the org fails to load (e.g., syntax error), logs the error and provides
 * an empty organisation so the server can start. When the developer fixes the
 * error and saves, `bun --watch` will restart the process and load the fixed org.
 *
 * Requires NODE_ENV=development for graceful fallback behavior.
 * When NODE_ENV is unset or any other value, behaves like OrganisationProviderFromPath
 * and fails on load errors.
 *
 * @param orgPath - Path to the organisation package (relative or absolute)
 */
export const OrganisationProviderFromPathDev = (
  orgPath: string,
): Layer.Layer<
  OrganisationProvider,
  OrganisationLoadError | PlatformError,
  FileSystem.FileSystem
> =>
  Layer.effect(
    OrganisationProvider,
    Effect.gen(function* () {
      yield* Effect.log(`Loading organisation from: ${orgPath}`)

      const result = yield* Effect.either(loadOrganisationFromPath(orgPath))

      return yield* Either.match(result, {
        onLeft: (error) =>
          Effect.gen(function* () {
            // In production, fail immediately - don't swallow errors
            if (!isDevMode()) {
              return yield* error
            }

            yield* Effect.logError(
              `Failed to load organisation: ${error.message}`,
            )
            if (error.cause instanceof Error) {
              yield* Effect.logError("Organisation load error details", {
                ...(error.cause.stack
                  ? { causeStack: error.cause.stack }
                  : {
                      causeName: error.cause.name,
                      causeMessage: error.cause.message,
                    }),
              })
            } else if (error.cause !== undefined) {
              yield* Effect.logError("Organisation load error details", {
                cause: String(error.cause),
              })
            }
            yield* Effect.logWarning(
              "Using empty organisation - org has errors. Fix and save to reload.",
            )

            const absoluteOrgPath = path.resolve(process.cwd(), orgPath)
            const emptyOrg = new OrganisationClass({
              name: "Empty (org failed to load)",
            })

            // Use makeService to get correct schema path (checks dist/ first)
            return yield* makeService({
              org: emptyOrg,
              orgPath: absoluteOrgPath,
            })
          }),
        onRight: ({
          org,
          resolvedPath,
          customDbLayer,
          customGraphqlSchema,
          customJobLayer,
          serverPlugins,
        }) =>
          Effect.gen(function* () {
            yield* logLoadedOrganisation({
              name: org.name,
              customDbLayer,
              customJobLayer,
              serverPlugins,
            })
            return yield* makeService({
              org,
              orgPath: resolvedPath,
              customDbLayer,
              customGraphqlSchema,
              customJobLayer,
              serverPlugins,
            })
          }),
      })
    }),
  )
