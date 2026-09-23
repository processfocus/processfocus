import { createHash, randomUUID } from "node:crypto"
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { FileSystem } from "@effect/platform"
import {
  ARTIFACT_INVENTORY_FILENAME,
  ARTIFACT_INVENTORY_FORMAT,
  ARTIFACT_INVENTORY_VERSION,
} from "@processfocus/runtime"
import { Console, Effect } from "effect"
import { extractPolicyFiles, extractSchemaFiles } from "@pf/auth-config"
import {
  BROWSER_PLUGIN_ARTIFACT_MANIFEST_FILE,
  BROWSER_PLUGIN_ARTIFACT_MANIFEST_FORMAT,
  BROWSER_PLUGIN_ARTIFACT_MANIFEST_VERSION,
  type BrowserPluginArtifactEntry,
  type BrowserPluginArtifactManifest,
  type CustomGraphqlSchemaDefinition,
  ORGANISATION_DEPLOY_MANIFEST_FILE,
  ORGANISATION_DEPLOY_MANIFEST_FORMAT,
  ORGANISATION_DEPLOY_MANIFEST_VERSION,
  ORGANISATION_FRONTEND_MANIFEST_FILE,
  ORGANISATION_FRONTEND_MANIFEST_VERSION,
  type OrganisationFrontendManifest,
  buildOrganisationBrowserPluginBuildInput,
  buildOrganisationDeployManifest,
  buildOrganisationFrontendManifest,
  buildOrganisationFrontendManifestAppIconFiles,
  buildOrganisationFrontendManifestPublicFormBrandingFiles,
  findOrganisationBrowserPluginArtifactProviders,
  isOrganisation,
} from "@pf/process"
import { BuildError, GraphqlSchemaError, PolicyFileError } from "../errors"
import { CLI_PRODUCER } from "../producer"
import { validateFlows } from "../utils/validate-flows"

declare const PFCLI_DISTRIBUTION_BUILD: boolean

// These runtime modules have target-resolved assets or runtime-specific
// implementations. Keep them external so deploy artifacts resolve them from
// the organisation dependencies instead of baking in build-machine paths.
// @tursodatabase/serverless is intentionally NOT external: the AWS Lambda
// Docker images do not install it, so it must be bundled into org.js.
// @tursodatabase/database and @tursodatabase/sync have native binaries and
// cannot be bundled. They must only be dynamically imported in bundle code
// so AWS Lambda (which does not install them) never resolves them at startup.
const BUNDLE_EXTERNAL_MODULES = [
  "@cedar-policy/cedar-wasm",
  "@tursodatabase/database",
  "@tursodatabase/sync",
]
const LEGACY_FRONTEND_MANIFEST_FILES = [
  "embed-manifest.json",
  "frontend-plugin-manifest.json",
]

const ORG_BUNDLE_FORMAT = "processfocus/org-bundle"
const GRAPHQL_SCHEMA_FORMAT = "processfocus/graphql-schema"
const CEDAR_POLICIES_FORMAT = "processfocus/cedar-policies"
const FRONTEND_MANIFEST_FORMAT = "processfocus/frontend-manifest"
const BROWSER_PLUGIN_BUNDLE_FORMAT = "processfocus/browser-plugin-bundle"
const BROWSER_PLUGIN_PREPARATION_FORMAT =
  "processfocus/browser-plugin-preparation"
const BROWSER_PLUGIN_BUNDLE_DIRECTORY = "browser-plugins"
const BROWSER_PLUGIN_BUILD_TIMEOUT_MS = 90_000
const BROWSER_PLUGIN_VALIDATION_TIMEOUT_MS = 30_000
const BROWSER_PLUGIN_HOST_EXTERNALS = [
  "next/*",
  "react",
  "react/*",
  "react-dom",
  "react-dom/*",
] as const

type BundledGraphqlSchemaBuilder = (
  orgPath: string,
  customSchema: CustomGraphqlSchemaDefinition | undefined,
) => Promise<string>

const parseBundledGraphqlSchemaBuilder = (
  module: unknown,
): BundledGraphqlSchemaBuilder => {
  if (
    typeof module !== "object" ||
    module === null ||
    !("__pfBuildDynamicSchema" in module) ||
    typeof module.__pfBuildDynamicSchema !== "function"
  ) {
    throw new Error(
      "Bundled organisation does not expose its GraphQL schema generator",
    )
  }

  const buildDynamicSchema = module.__pfBuildDynamicSchema
  return async (orgPath, customSchema) => {
    const schema: unknown = await buildDynamicSchema(orgPath, customSchema)
    if (typeof schema !== "string") {
      throw new Error(
        "Bundled organisation GraphQL schema generator did not return a string",
      )
    }
    return schema
  }
}

const sha256OfFile = (filePath: string): string =>
  createHash("sha256").update(readFileSync(filePath)).digest("hex")

const buildBrowserPluginStylesheet = (options: {
  readonly browserArtifactPath: string
  readonly entrypoint: string
  readonly identity: string
  readonly orgPath: string
  readonly outputDir: string
}): NonNullable<BrowserPluginArtifactEntry["preparation"]> => {
  let resolvedEntrypoint: string
  try {
    resolvedEntrypoint = Bun.resolveSync(options.entrypoint, options.orgPath)
  } catch (cause) {
    throw new Error(
      `browser plugin "${options.identity}" preparation entrypoint ${JSON.stringify(options.entrypoint)} cannot be resolved from the organisation`,
      { cause },
    )
  }
  if (path.extname(resolvedEntrypoint) !== ".css") {
    throw new Error(
      `browser plugin "${options.identity}" stylesheet preparation entrypoint must resolve to a .css file`,
    )
  }

  const source = readFileSync(resolvedEntrypoint, "utf8")
  const artifactSource = `${source.replaceAll(/@source\s+["'][^"']+["']\s*;/g, "").trimEnd()}\n\n@source "./${path.basename(options.browserArtifactPath)}";\n`
  const temporaryPath = path.join(
    options.outputDir,
    BROWSER_PLUGIN_BUNDLE_DIRECTORY,
    `.tmp-${randomUUID()}.css`,
  )
  writeFileSync(temporaryPath, artifactSource)
  const sha256 = sha256OfFile(temporaryPath)
  const artifactPath = `${BROWSER_PLUGIN_BUNDLE_DIRECTORY}/${sha256}.css`
  const contentAddressedPath = path.join(options.outputDir, artifactPath)
  if (existsSync(contentAddressedPath)) {
    rmSync(temporaryPath, { force: true })
  } else {
    renameSync(temporaryPath, contentAddressedPath)
  }

  return {
    kind: "stylesheet",
    path: artifactPath,
    sha256,
  }
}

const BROWSER_PLUGIN_VALIDATION_SCRIPT = `
try {
  const input = JSON.parse(await Bun.stdin.text())
  const artifact = await import(input.artifactUrl)
  if (typeof artifact.shouldActivate !== "function") {
    throw new Error("artifact must export shouldActivate()")
  }
  if (!artifact.plugin || typeof artifact.plugin.activate !== "function") {
    throw new Error("artifact must export plugin.activate()")
  }
  if (artifact.plugin.id !== input.identity) {
    throw new Error("artifact plugin id must match its manifest identity")
  }

  const analytics = []
  const formRenderers = []
  const executionMenuActions = []
  const register = (registrations) => (registration) => {
    registrations.push(registration)
    return () => undefined
  }
  const host = {
    kind: "organisation-plugin-host",
    interfaceVersion: input.hostInterfaceVersion,
    analytics: { register: register(analytics) },
    formRenderers: { register: register(formRenderers) },
    executionMenu: { register: register(executionMenuActions) },
    graphql: { ClientConsumer: () => null },
  }
  if (!(await artifact.shouldActivate(input.config, "production"))) {
    throw new Error("configured artifact declined production activation")
  }
  await artifact.plugin.activate(host)

  if (input.category === "analytics") {
    const registration = analytics.find(
      (candidate) => candidate.type === input.identity,
    )
    if (!registration || typeof registration.render !== "function") {
      throw new Error(
        "artifact did not register its configured analytics render path",
      )
    }
    registration.render(input.config)
  } else {
    const registration = formRenderers.find(
      (candidate) => candidate.type === input.identity,
    )
    const menuAction = executionMenuActions.find(
      (candidate) =>
        typeof candidate.id === "string" &&
        typeof candidate.label === "string" &&
        typeof candidate.isVisible === "function" &&
        typeof candidate.onSelect === "function",
    )
    if (!registration && !menuAction) {
      throw new Error(
        "artifact did not register a form renderer or execution-menu action",
      )
    }
    if (registration) {
      if (typeof registration.renderer !== "function") {
        throw new Error(
          "artifact registered an invalid form-component render path",
        )
      }
      registration.renderer(
        {
          AppField: ({ children }) => children(),
          Subscribe: ({ children }) =>
            typeof children === "function" ? children({ values: {} }) : children,
        },
        {
          _tag: "plugin",
          field: "browserPluginValidation",
          label: "Browser plugin validation",
          pluginType: input.identity,
        },
        false,
      )
    }
  }
} catch {
  process.exitCode = 1
}
`

const validateBrowserPluginArtifact = (options: {
  readonly artifactPath: string
  readonly category: BrowserPluginArtifactEntry["category"]
  readonly config: unknown
  readonly entrypointPath: string
  readonly hostInterfaceVersion: number
  readonly identity: string
  readonly orgPath: string
}): void => {
  const hostModuleSearchPaths = ["react", "react-dom", "next"].flatMap(
    (packageName) => {
      try {
        const packageJsonPath = Bun.resolveSync(
          `${packageName}/package.json`,
          path.dirname(options.entrypointPath),
        )
        return [path.dirname(path.dirname(packageJsonPath))]
      } catch {
        return []
      }
    },
  )
  const nodePath = [...new Set(hostModuleSearchPaths)].join(path.delimiter)
  const validationInput = new TextEncoder().encode(
    JSON.stringify({
      artifactUrl: pathToFileURL(options.artifactPath).href,
      category: options.category,
      config: options.config,
      hostInterfaceVersion: options.hostInterfaceVersion,
      identity: options.identity,
    }),
  )
  const validation = Bun.spawnSync(
    [process.execPath, "--no-install", "-e", BROWSER_PLUGIN_VALIDATION_SCRIPT],
    {
      cwd: options.orgPath,
      env: { NODE_ENV: "production", NODE_PATH: nodePath },
      stdin: validationInput,
      stderr: "ignore",
      stdout: "ignore",
      timeout: BROWSER_PLUGIN_VALIDATION_TIMEOUT_MS,
    },
  )

  if (validation.exitedDueToTimeout) {
    throw new Error(
      `browser plugin "${options.identity}" production validation timed out after ${BROWSER_PLUGIN_VALIDATION_TIMEOUT_MS / 1000}s`,
    )
  }
  if (validation.exitCode !== 0) {
    throw new Error(
      `browser plugin "${options.identity}" failed production render validation`,
    )
  }
}

const buildBrowserPluginArtifacts = (options: {
  readonly org: Parameters<
    typeof findOrganisationBrowserPluginArtifactProviders
  >[0]
  readonly orgPath: string
  readonly outputDir: string
  readonly frontendManifest: OrganisationFrontendManifest
}): BrowserPluginArtifactManifest => {
  const activeSelections = new Map(
    [
      ...options.frontendManifest.plugins.analytics.map((plugin) => ({
        category: "analytics" as const,
        config: plugin.config,
        identity: plugin.type,
      })),
      ...options.frontendManifest.plugins.formComponents.map((plugin) => ({
        category: "formComponents" as const,
        config: undefined,
        identity: plugin.type,
      })),
    ].map((selection) => [selection.identity, selection]),
  )
  const inputs = findOrganisationBrowserPluginArtifactProviders(options.org)
    .filter((provider) => provider.frontendManifestPluginCategory !== undefined)
    .map((provider) => ({
      providerPath: provider.node.path,
      input: buildOrganisationBrowserPluginBuildInput(provider),
    }))
  const identities = new Set<string>()
  const validatedInputs = inputs.map(({ providerPath, input }) => {
    if (identities.has(input.identity)) {
      throw new Error(`duplicate browser plugin identity "${input.identity}"`)
    }
    identities.add(input.identity)

    const selection = activeSelections.get(input.identity)
    if (!selection) {
      throw new Error(
        `browser plugin "${input.identity}" from ${providerPath} has no active frontend manifest selection`,
      )
    }
    if (selection.category !== input.category) {
      throw new Error(
        `browser plugin "${input.identity}" from ${providerPath} declares category "${input.category}" but its frontend manifest selection is "${selection.category}"`,
      )
    }
    return { input, selection }
  })

  const browserPluginDirectory = path.join(
    options.outputDir,
    BROWSER_PLUGIN_BUNDLE_DIRECTORY,
  )
  mkdirSync(browserPluginDirectory, { recursive: true })

  const plugins: BrowserPluginArtifactEntry[] = validatedInputs.map(
    ({ input, selection }): BrowserPluginArtifactEntry => {
      let resolvedEntrypoint: string
      try {
        resolvedEntrypoint = Bun.resolveSync(input.entrypoint, options.orgPath)
      } catch (cause) {
        throw new Error(
          `browser plugin "${input.identity}" entrypoint ${JSON.stringify(input.entrypoint)} cannot be resolved from the organisation`,
          { cause },
        )
      }

      const temporaryName = `.tmp-${randomUUID()}.js`
      const temporaryPath = path.join(browserPluginDirectory, temporaryName)
      const build = Bun.spawnSync(
        [
          "bun",
          "build",
          resolvedEntrypoint,
          "--outdir",
          browserPluginDirectory,
          "--entry-naming",
          temporaryName,
          "--target",
          "browser",
          "--format",
          "esm",
          "--production",
          "--minify",
          ...BROWSER_PLUGIN_HOST_EXTERNALS.flatMap((external) => [
            "--external",
            external,
          ]),
        ],
        {
          cwd: options.orgPath,
          env: { ...process.env, NODE_ENV: "production" },
          stderr: "pipe",
          stdout: "pipe",
          timeout: BROWSER_PLUGIN_BUILD_TIMEOUT_MS,
        },
      )

      if (build.exitedDueToTimeout) {
        rmSync(temporaryPath, { force: true })
        throw new Error(
          `browser plugin "${input.identity}" bundle timed out after ${BROWSER_PLUGIN_BUILD_TIMEOUT_MS / 1000}s`,
        )
      }
      if (build.exitCode !== 0) {
        rmSync(temporaryPath, { force: true })
        const decoder = new TextDecoder()
        const details =
          decoder.decode(build.stderr).trim() ||
          decoder.decode(build.stdout).trim()
        throw new Error(
          `browser plugin "${input.identity}" bundle failed${details ? `: ${details}` : ""}`,
        )
      }
      if (!existsSync(temporaryPath)) {
        throw new Error(
          `browser plugin "${input.identity}" bundle did not produce ${temporaryPath}`,
        )
      }

      try {
        validateBrowserPluginArtifact({
          artifactPath: temporaryPath,
          category: input.category,
          config: selection.config,
          entrypointPath: resolvedEntrypoint,
          hostInterfaceVersion: input.hostInterfaceVersion,
          identity: input.identity,
          orgPath: options.orgPath,
        })
      } catch (cause) {
        rmSync(temporaryPath, { force: true })
        throw cause
      }

      const sha256 = sha256OfFile(temporaryPath)
      const artifactPath = `${BROWSER_PLUGIN_BUNDLE_DIRECTORY}/${sha256}.js`
      const contentAddressedPath = path.join(options.outputDir, artifactPath)
      if (existsSync(contentAddressedPath)) {
        rmSync(temporaryPath, { force: true })
      } else {
        renameSync(temporaryPath, contentAddressedPath)
      }

      return {
        identity: input.identity,
        category: input.category,
        hostInterfaceVersion: input.hostInterfaceVersion,
        path: artifactPath,
        sha256,
        ...(input.preparation !== undefined && {
          preparation: buildBrowserPluginStylesheet({
            browserArtifactPath: artifactPath,
            entrypoint: input.preparation.entrypoint,
            identity: input.identity,
            orgPath: options.orgPath,
            outputDir: options.outputDir,
          }),
        }),
      }
    },
  )

  return {
    format: BROWSER_PLUGIN_ARTIFACT_MANIFEST_FORMAT,
    version: BROWSER_PLUGIN_ARTIFACT_MANIFEST_VERSION,
    plugins,
  }
}

/**
 * Build command - bundles organisation and generates artifacts.
 *
 * Steps:
 * 1. Ensure output directory exists
 * 2. Bundle the full org entrypoint with bun build
 * 3. Generate deploy manifest
 * 4. Generate frontend manifest
 * 5. Generate GraphQL schema
 * 6. Copy Cedar policies
 *
 * @param orgPath - Path to organisation directory
 * @param outputDir - Output directory (default: "dist")
 */
export const runBuild = (orgPath: string, outputDir = "dist") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const bundledDbImportPath = fileURLToPath(
      typeof PFCLI_DISTRIBUTION_BUILD === "undefined"
        ? new URL("../utils/bundled-db-import.ts", import.meta.url)
        : new URL("./bundled-db-import.mjs", import.meta.url),
    )
    const bundledGraphqlSchemaPath = fileURLToPath(
      typeof PFCLI_DISTRIBUTION_BUILD === "undefined"
        ? new URL("../utils/bundled-graphql-schema.ts", import.meta.url)
        : new URL("./bundled-graphql-schema.mjs", import.meta.url),
    )

    // Resolve absolute paths
    const absoluteOrgPath = path.resolve(process.cwd(), orgPath)
    const absoluteOutputDir = path.resolve(absoluteOrgPath, outputDir)
    yield* Console.log(`Building organisation from: ${absoluteOrgPath}`)
    yield* Console.log(`Output directory: ${absoluteOutputDir}`)

    // Step 1: Ensure output directory exists
    yield* Console.log("\n[1/6] Preparing output directory...")
    yield* fs.makeDirectory(absoluteOutputDir, { recursive: true })
    yield* Effect.sync(() => {
      for (const fileName of LEGACY_FRONTEND_MANIFEST_FILES) {
        rmSync(path.join(absoluteOutputDir, fileName), { force: true })
      }

      rmSync(path.join(absoluteOutputDir, "_pf", "app-icons"), {
        force: true,
        recursive: true,
      })
      rmSync(path.join(absoluteOutputDir, "_pf", "public-form-branding"), {
        force: true,
        recursive: true,
      })
      rmSync(path.join(absoluteOutputDir, "docs"), {
        force: true,
        recursive: true,
      })
      rmSync(
        path.join(absoluteOutputDir, BROWSER_PLUGIN_ARTIFACT_MANIFEST_FILE),
        { force: true },
      )
      rmSync(path.join(absoluteOutputDir, BROWSER_PLUGIN_BUNDLE_DIRECTORY), {
        force: true,
        recursive: true,
      })
    })

    // Step 2: Bundle organisation
    yield* Console.log("\n[2/6] Bundling organisation...")
    const indexPath = path.join(absoluteOrgPath, "src/index.ts")
    const sourcePath = indexPath
    const bundledPath = path.join(absoluteOutputDir, "org.js")
    const tempBundleEntryDir = path.join(
      tmpdir(),
      `.pfcli-build-${randomUUID()}`,
    )

    // Verify source exists
    const sourceExists = yield* fs.exists(sourcePath)
    if (!sourceExists) {
      return yield* new BuildError({
        message: `Source file not found: ${sourcePath}`,
      })
    }

    yield* fs.makeDirectory(tempBundleEntryDir, { recursive: true })

    const generatedBundleEntryPath = path.join(tempBundleEntryDir, "entry.ts")
    const bundledDbImportFactoryExportName = "createBundledDbImport"
    const tempEntrySource = [
      `import * as OrgModule from ${globalThis.JSON.stringify(sourcePath)}`,
      `import { createBundledDbImport } from ${globalThis.JSON.stringify(bundledDbImportPath)}`,
      `import { buildBundledGraphqlSchema } from ${globalThis.JSON.stringify(bundledGraphqlSchemaPath)}`,
      `export * from ${globalThis.JSON.stringify(sourcePath)}`,
      `export const dbImport = ${bundledDbImportFactoryExportName}(OrgModule, ${globalThis.JSON.stringify(absoluteOrgPath)})`,
      "export const __pfBuildDynamicSchema = (orgPath, customGraphqlSchema) => buildBundledGraphqlSchema(OrgModule.org, orgPath, customGraphqlSchema)",
      "",
    ].join("\n")

    yield* fs.writeFileString(generatedBundleEntryPath, tempEntrySource).pipe(
      Effect.mapError(
        (error) =>
          new BuildError({
            message: "Failed to create temporary bundle entrypoint",
            cause: error,
          }),
      ),
    )

    // Run bun build
    // Note: --outfile doesn't work reliably with bun, use --outdir + --entry-naming instead
    const bunBuildArgs = [
      "build",
      generatedBundleEntryPath,
      "--outdir",
      absoluteOutputDir,
      "--entry-naming",
      "org.js",
      "--minify",
      "--target",
      "node",
      "--conditions",
      "bun",
      ...BUNDLE_EXTERNAL_MODULES.flatMap((moduleName) => [
        "--external",
        moduleName,
      ]),
    ]
    const BUN_BUILD_TIMEOUT_MS = 90_000
    const bunBuild = yield* Effect.try({
      try: () =>
        Bun.spawnSync(["bun", ...bunBuildArgs], {
          cwd: absoluteOrgPath,
          stderr: "pipe",
          stdout: "pipe",
          timeout: BUN_BUILD_TIMEOUT_MS,
        }),
      catch: (error) =>
        new BuildError({
          message: "Failed to bundle organisation with bun build",
          cause: error,
        }),
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          try {
            rmSync(generatedBundleEntryPath, { force: true })
          } catch {
            // Ignore temp file cleanup failures.
          }

          try {
            rmdirSync(tempBundleEntryDir)
          } catch {
            // Ignore shared temp directory cleanup failures.
          }
        }),
      ),
    )

    if (bunBuild.exitedDueToTimeout) {
      return yield* new BuildError({
        message: `bun build timed out after ${BUN_BUILD_TIMEOUT_MS / 1000}s`,
      })
    }

    if (bunBuild.exitCode !== 0) {
      const decoder = new TextDecoder()
      const stderr = decoder.decode(bunBuild.stderr).trim()
      const stdout = decoder.decode(bunBuild.stdout).trim()
      const details = stderr || stdout
      return yield* new BuildError({
        message: details
          ? `bun build failed with exit code ${bunBuild.exitCode}: ${details}`
          : `bun build failed with exit code ${bunBuild.exitCode}`,
      })
    }

    const orgBundleContents = yield* fs.readFileString(bundledPath).pipe(
      Effect.mapError(
        (error) =>
          new BuildError({
            message: `Failed to read bundled organisation: ${bundledPath}`,
            cause: error,
          }),
      ),
    )
    const orgBundleSha256 = createHash("sha256")
      .update(orgBundleContents)
      .digest("hex")

    yield* Console.log(`✅ Bundled: ${bundledPath}`)

    // Step 3: Generate deploy manifest
    yield* Console.log(
      `\n[3/6] Generating deploy v${ORGANISATION_DEPLOY_MANIFEST_VERSION} manifest...`,
    )

    // Load the source module for schema generation and adjacent build assets.
    // Stable model brands keep this valid when the organisation uses the
    // separately installed authoring package.
    const orgModule = yield* Effect.tryPromise({
      try: async () => import(sourcePath),
      catch: (error) =>
        new BuildError({
          message: `Failed to import organisation: ${error}`,
          cause: error,
        }),
    })

    if (!orgModule.org) {
      return yield* new BuildError({
        message: `Module at ${sourcePath} must export an 'org' named export.`,
      })
    }

    if (!isOrganisation(orgModule.org)) {
      return yield* new BuildError({
        message: `Export 'org' at ${sourcePath} must be an Organisation instance.`,
      })
    }

    const org = orgModule.org
    const customGraphqlSchema = orgModule.CustomGraphqlSchema
    const customAwsRuntimeConfig = orgModule.CustomAwsRuntimeConfig
    const customGraphqlDir = path.join(absoluteOrgPath, "graphql")

    // Validate all process flows
    yield* validateFlows(org).pipe(
      Effect.mapError(
        (error) =>
          new BuildError({
            message: "Process flow validation failed",
            cause: error,
          }),
      ),
    )

    const deployManifest = yield* Effect.try({
      try: () =>
        buildOrganisationDeployManifest({
          org,
          orgBundleSha256,
          producer: CLI_PRODUCER,
          customAwsRuntimeConfig,
        }),
      catch: (error) =>
        new BuildError({
          message: "Failed to generate deploy manifest",
          cause: error,
        }),
    })

    const deployManifestPath = path.join(
      absoluteOutputDir,
      ORGANISATION_DEPLOY_MANIFEST_FILE,
    )
    const deployManifestTmpPath = `${deployManifestPath}.tmp`
    // @effect-diagnostics effect/preferSchemaOverJson:off
    const deployManifestJson = JSON.stringify(deployManifest, null, 2)
    yield* fs.writeFileString(deployManifestTmpPath, `${deployManifestJson}\n`)
    yield* fs.rename(deployManifestTmpPath, deployManifestPath)

    yield* Console.log(`✅ Generated: ${deployManifestPath}`)

    // Step 4: Generate frontend manifest and copy adjacent public assets
    yield* Console.log(
      `\n[4/6] Generating frontend v${ORGANISATION_FRONTEND_MANIFEST_VERSION} manifest...`,
    )

    const frontendManifest = yield* buildOrganisationFrontendManifest(org, {
      basePath: absoluteOrgPath,
    }).pipe(
      Effect.mapError(
        (error) =>
          new BuildError({
            message:
              error instanceof Error
                ? error.message
                : "Failed to generate frontend manifest",
            cause: error,
          }),
      ),
    )

    const frontendManifestPath = path.join(
      absoluteOutputDir,
      ORGANISATION_FRONTEND_MANIFEST_FILE,
    )
    const frontendManifestTmpPath = `${frontendManifestPath}.tmp`
    const frontendManifestJson = JSON.stringify(frontendManifest, null, 2)
    yield* fs.writeFileString(
      frontendManifestTmpPath,
      `${frontendManifestJson}\n`,
    )
    yield* fs.rename(frontendManifestTmpPath, frontendManifestPath)

    const appIconFiles = yield* Effect.try({
      try: () =>
        buildOrganisationFrontendManifestAppIconFiles(org, {
          basePath: absoluteOrgPath,
        }),
      catch: (error) =>
        new BuildError({
          message:
            error instanceof Error
              ? error.message
              : "Failed to collect App Icons files",
          cause: error,
        }),
    })

    const browserPluginManifest = yield* Effect.try({
      try: () =>
        buildBrowserPluginArtifacts({
          org,
          orgPath: absoluteOrgPath,
          outputDir: absoluteOutputDir,
          frontendManifest,
        }),
      catch: (error) =>
        new BuildError({
          message:
            error instanceof Error
              ? error.message
              : "Failed to build browser plugin artifacts",
          cause: error,
        }),
    })
    const browserPluginManifestPath = path.join(
      absoluteOutputDir,
      BROWSER_PLUGIN_ARTIFACT_MANIFEST_FILE,
    )
    const browserPluginManifestTmpPath = `${browserPluginManifestPath}.tmp`
    yield* fs.writeFileString(
      browserPluginManifestTmpPath,
      `${JSON.stringify(browserPluginManifest, null, 2)}\n`,
    )
    yield* fs.rename(browserPluginManifestTmpPath, browserPluginManifestPath)

    const appIconsOutputDir = path.resolve(absoluteOutputDir, "_pf/app-icons")
    for (const appIconFile of appIconFiles) {
      const outputPath = path.resolve(
        absoluteOutputDir,
        appIconFile.publicPath.replace(/^\//, ""),
      )

      if (!outputPath.startsWith(`${appIconsOutputDir}${path.sep}`)) {
        return yield* new BuildError({
          message: `App Icons public path resolved outside ${appIconsOutputDir}: ${appIconFile.publicPath}`,
        })
      }

      yield* fs.makeDirectory(path.dirname(outputPath), { recursive: true })
      yield* fs.copyFile(appIconFile.sourcePath, outputPath).pipe(
        Effect.mapError(
          (error) =>
            new BuildError({
              message: `Failed to copy App Icons file: ${appIconFile.sourcePath}`,
              cause: error,
            }),
        ),
      )
    }

    const publicFormBrandingFiles = yield* Effect.try({
      try: () =>
        buildOrganisationFrontendManifestPublicFormBrandingFiles(org, {
          basePath: absoluteOrgPath,
        }),
      catch: (error) =>
        new BuildError({
          message:
            error instanceof Error
              ? error.message
              : "Failed to collect Public Form Branding files",
          cause: error,
        }),
    })

    const publicFormBrandingOutputDir = path.resolve(
      absoluteOutputDir,
      "_pf/public-form-branding",
    )
    for (const brandingFile of publicFormBrandingFiles) {
      const outputPath = path.resolve(
        absoluteOutputDir,
        brandingFile.publicPath.replace(/^\//, ""),
      )

      if (!outputPath.startsWith(`${publicFormBrandingOutputDir}${path.sep}`)) {
        return yield* new BuildError({
          message: `Public Form Branding public path resolved outside ${publicFormBrandingOutputDir}: ${brandingFile.publicPath}`,
        })
      }

      yield* fs.makeDirectory(path.dirname(outputPath), { recursive: true })
      yield* fs.copyFile(brandingFile.sourcePath, outputPath).pipe(
        Effect.mapError(
          (error) =>
            new BuildError({
              message: `Failed to copy Public Form Branding file: ${brandingFile.sourcePath}`,
              cause: error,
            }),
        ),
      )
    }

    const docsSourceDir = path.join(absoluteOrgPath, "docs")
    const docsOutputDir = path.join(absoluteOutputDir, "docs")
    const docsSourceExists = yield* fs.exists(docsSourceDir)
    if (docsSourceExists) {
      yield* Effect.sync(() => {
        cpSync(docsSourceDir, docsOutputDir, { recursive: true })
      })
      yield* Console.log(`✅ Copied docs: ${docsOutputDir}`)
    }

    yield* Console.log(`✅ Generated: ${frontendManifestPath}`)
    yield* Console.log(`✅ Generated: ${browserPluginManifestPath}`)

    yield* Console.log("\n[5/6] Generating GraphQL schema...")

    const customGraphqlSources = [] as Array<{
      fileName: string
      content: string
    }>
    const customGraphqlDirExists = yield* fs.exists(customGraphqlDir)

    if (customGraphqlDirExists) {
      const graphqlEntries = (yield* fs.readDirectory(customGraphqlDir))
        .filter((entry) => entry.endsWith(".graphql"))
        .sort()

      if (graphqlEntries.length > 0) {
        yield* Console.log(
          `Found ${graphqlEntries.length} custom GraphQL file(s) in organisation`,
        )
      }

      for (const graphqlFile of graphqlEntries) {
        const graphqlPath = path.join(customGraphqlDir, graphqlFile)
        const graphqlContent = yield* fs.readFileString(graphqlPath).pipe(
          Effect.mapError(
            (error) =>
              new GraphqlSchemaError({
                message: `Failed to read custom GraphQL file: ${graphqlFile}`,
                cause: error,
              }),
          ),
        )

        customGraphqlSources.push({
          fileName: graphqlFile,
          content: graphqlContent,
        })
      }
    }

    const resolvedCustomGraphqlSchema =
      customGraphqlSchema || customGraphqlSources.length > 0
        ? {
            ...(customGraphqlSchema ?? {}),
            ...(customGraphqlSources.length > 0
              ? {
                  typeDefs: [
                    customGraphqlSchema?.typeDefs?.trim(),
                    ...customGraphqlSources.map(({ content }) =>
                      content.trim(),
                    ),
                  ]
                    .filter(
                      (content): content is string => content !== undefined,
                    )
                    .join("\n\n"),
                }
              : {}),
          }
        : undefined

    const bundledOrgModule = yield* Effect.tryPromise({
      try: async (): Promise<unknown> =>
        import(`${pathToFileURL(bundledPath).href}?sha256=${orgBundleSha256}`),
      catch: (error) =>
        new GraphqlSchemaError({
          message: "Failed to load bundled organisation schema generator",
          cause: error,
        }),
    })
    const buildBundledDynamicSchema = yield* Effect.try({
      try: () => parseBundledGraphqlSchemaBuilder(bundledOrgModule),
      catch: (error) =>
        new GraphqlSchemaError({
          message:
            error instanceof Error
              ? error.message
              : "Bundled organisation schema generator is invalid",
          cause: error,
        }),
    })
    const schema = yield* Effect.tryPromise({
      try: () =>
        buildBundledDynamicSchema(absoluteOrgPath, resolvedCustomGraphqlSchema),
      catch: (error) =>
        new GraphqlSchemaError({
          message: "Failed to generate GraphQL schema",
          cause: error,
        }),
    })

    // Write schema to dist/graphql/org.graphql (atomic via temp+rename)
    const schemaDir = path.join(absoluteOutputDir, "graphql")
    const schemaPath = path.join(schemaDir, "org.graphql")
    const schemaTmpPath = path.join(schemaDir, "org.graphql.tmp")
    yield* fs.makeDirectory(schemaDir, { recursive: true })

    for (const { fileName, content } of customGraphqlSources) {
      const targetPath = path.join(schemaDir, fileName)
      const tmpPath = path.join(schemaDir, `${fileName}.tmp`)
      yield* fs.writeFileString(tmpPath, content)
      yield* fs.rename(tmpPath, targetPath)
      yield* Console.log(`✅ Copied custom GraphQL: ${fileName}`)
    }

    yield* fs.writeFileString(schemaTmpPath, `${schema}\n`)
    yield* fs.rename(schemaTmpPath, schemaPath)
    yield* Console.log(`✅ Generated: ${schemaPath}`)

    // Step 6: Copy Cedar policies
    yield* Console.log("\n[6/6] Copying Cedar policies...")

    const cedarOutputDir = path.join(absoluteOutputDir, "cedar")
    yield* fs.makeDirectory(cedarOutputDir, { recursive: true })

    // Source execution reads the workspace policy source; distribution builds
    // replace the mode flag and use the immutable copy beside the executable.
    const cedarPath = fileURLToPath(
      typeof PFCLI_DISTRIBUTION_BUILD === "undefined"
        ? new URL("../../../../packages/auth-policy/cedar/", import.meta.url)
        : new URL("./resources/cedar/", import.meta.url),
    )
    const defaultPoliciesPath = path.join(cedarPath, "policies.cedar")
    const defaultSchemaPath = path.join(cedarPath, "schema.cedarschema")

    // Copy default policies (atomic via temp+rename)
    const defaultPoliciesExist = yield* fs.exists(defaultPoliciesPath)
    if (defaultPoliciesExist) {
      const policiesContent = yield* fs.readFileString(defaultPoliciesPath)
      const policiesTargetPath = path.join(cedarOutputDir, "policies.cedar")
      const policiesTmpPath = path.join(cedarOutputDir, "policies.cedar.tmp")
      yield* fs.writeFileString(policiesTmpPath, policiesContent)
      yield* fs.rename(policiesTmpPath, policiesTargetPath)
      yield* Console.log(`✅ Copied: policies.cedar`)
    } else {
      yield* Console.warn(
        `⚠️  Default policies not found: ${defaultPoliciesPath}`,
      )
    }

    // Copy default schema (atomic via temp+rename)
    const defaultSchemaExist = yield* fs.exists(defaultSchemaPath)
    if (defaultSchemaExist) {
      const schemaContent = yield* fs.readFileString(defaultSchemaPath)
      const schemaTargetPath = path.join(cedarOutputDir, "schema.cedarschema")
      const schemaTmpPath = path.join(cedarOutputDir, "schema.cedarschema.tmp")
      yield* fs.writeFileString(schemaTmpPath, schemaContent)
      yield* fs.rename(schemaTmpPath, schemaTargetPath)
      yield* Console.log(`✅ Copied: schema.cedarschema`)
    } else {
      yield* Console.warn(`⚠️  Default schema not found: ${defaultSchemaPath}`)
    }

    // Copy custom policy files from organisation's PoliciesConfig
    const customPolicyFiles = extractPolicyFiles(org)
    if (customPolicyFiles.length > 0) {
      yield* Console.log(
        `Found ${customPolicyFiles.length} custom policy file(s) in organisation`,
      )

      for (const policyFile of customPolicyFiles) {
        const sourcePolicyPath = path.join(absoluteOrgPath, policyFile)
        const policyExists = yield* fs.exists(sourcePolicyPath)

        if (!policyExists) {
          yield* Console.warn(
            `⚠️  Custom policy file not found: ${sourcePolicyPath}`,
          )
          continue
        }

        const policyContent = yield* fs.readFileString(sourcePolicyPath).pipe(
          Effect.mapError(
            (error) =>
              new PolicyFileError({
                message: `Failed to read custom policy file: ${policyFile}`,
                cause: error,
              }),
          ),
        )

        const fileName = path.basename(policyFile)
        const targetPath = path.join(cedarOutputDir, fileName)
        const tmpPath = path.join(cedarOutputDir, `${fileName}.tmp`)
        yield* fs.writeFileString(tmpPath, policyContent)
        yield* fs.rename(tmpPath, targetPath)
        yield* Console.log(`✅ Copied custom policy: ${fileName}`)
      }
    }

    // Copy custom schema files from organisation's CustomEntitiesConfig
    const customSchemaFiles = extractSchemaFiles(org)
    if (customSchemaFiles.length > 0) {
      yield* Console.log(
        `Found ${customSchemaFiles.length} custom schema file(s) in organisation`,
      )

      for (const schemaFile of customSchemaFiles) {
        const sourceSchemaPath = path.join(absoluteOrgPath, schemaFile)
        const schemaExists = yield* fs.exists(sourceSchemaPath)

        if (!schemaExists) {
          yield* Console.warn(
            `⚠️  Custom schema file not found: ${sourceSchemaPath}`,
          )
          continue
        }

        const schemaContent = yield* fs.readFileString(sourceSchemaPath).pipe(
          Effect.mapError(
            (error) =>
              new PolicyFileError({
                message: `Failed to read custom schema file: ${schemaFile}`,
                cause: error,
              }),
          ),
        )

        const fileName = path.basename(schemaFile)
        const targetPath = path.join(cedarOutputDir, fileName)
        const tmpPath = path.join(cedarOutputDir, `${fileName}.tmp`)
        yield* fs.writeFileString(tmpPath, schemaContent)
        yield* fs.rename(tmpPath, targetPath)
        yield* Console.log(`✅ Copied custom schema: ${fileName}`)
      }
    }

    yield* Console.log("\nGenerating artifact inventory...")

    const inventoryEntries = yield* Effect.try({
      try: () => {
        const entries: Array<{
          format: string
          version: number
          path: string
          sha256: string
        }> = [
          {
            format: ORG_BUNDLE_FORMAT,
            version: 1,
            path: "org.js",
            sha256: sha256OfFile(path.join(absoluteOutputDir, "org.js")),
          },
          {
            format: ORGANISATION_DEPLOY_MANIFEST_FORMAT,
            version: 1,
            path: ORGANISATION_DEPLOY_MANIFEST_FILE,
            sha256: sha256OfFile(
              path.join(absoluteOutputDir, ORGANISATION_DEPLOY_MANIFEST_FILE),
            ),
          },
          {
            format: FRONTEND_MANIFEST_FORMAT,
            version: ORGANISATION_FRONTEND_MANIFEST_VERSION,
            path: ORGANISATION_FRONTEND_MANIFEST_FILE,
            sha256: sha256OfFile(
              path.join(absoluteOutputDir, ORGANISATION_FRONTEND_MANIFEST_FILE),
            ),
          },
          {
            format: BROWSER_PLUGIN_ARTIFACT_MANIFEST_FORMAT,
            version: BROWSER_PLUGIN_ARTIFACT_MANIFEST_VERSION,
            path: BROWSER_PLUGIN_ARTIFACT_MANIFEST_FILE,
            sha256: sha256OfFile(
              path.join(
                absoluteOutputDir,
                BROWSER_PLUGIN_ARTIFACT_MANIFEST_FILE,
              ),
            ),
          },
          ...browserPluginManifest.plugins.flatMap((plugin) => [
            {
              format: BROWSER_PLUGIN_BUNDLE_FORMAT,
              version: plugin.hostInterfaceVersion,
              path: plugin.path,
              sha256: plugin.sha256,
            },
            ...(plugin.preparation === undefined
              ? []
              : [
                  {
                    format: BROWSER_PLUGIN_PREPARATION_FORMAT,
                    version: plugin.hostInterfaceVersion,
                    path: plugin.preparation.path,
                    sha256: plugin.preparation.sha256,
                  },
                ]),
          ]),
        ]

        const schemaPath = path.join(absoluteOutputDir, "graphql/org.graphql")
        if (existsSync(schemaPath)) {
          entries.push({
            format: GRAPHQL_SCHEMA_FORMAT,
            version: 1,
            path: "graphql/org.graphql",
            sha256: sha256OfFile(schemaPath),
          })
        }

        const cedarDir = path.join(absoluteOutputDir, "cedar")
        for (const file of readdirSync(cedarDir).sort()) {
          if (file.endsWith(".cedar") || file.endsWith(".cedarschema")) {
            entries.push({
              format: CEDAR_POLICIES_FORMAT,
              version: 1,
              path: `cedar/${file}`,
              sha256: sha256OfFile(path.join(cedarDir, file)),
            })
          }
        }

        return entries
      },
      catch: (error) =>
        new BuildError({
          message: "Failed to build artifact inventory",
          cause: error,
        }),
    })

    const inventory = {
      format: ARTIFACT_INVENTORY_FORMAT,
      version: ARTIFACT_INVENTORY_VERSION,
      producer: CLI_PRODUCER,
      entries: inventoryEntries,
    }
    const inventoryPath = path.join(
      absoluteOutputDir,
      ARTIFACT_INVENTORY_FILENAME,
    )
    const inventoryTmpPath = `${inventoryPath}.tmp`
    yield* fs.writeFileString(
      inventoryTmpPath,
      `${JSON.stringify(inventory, null, 2)}\n`,
    )
    yield* fs.rename(inventoryTmpPath, inventoryPath)
    yield* Console.log(`✅ Generated: ${inventoryPath}`)

    yield* Console.log(
      `\n✅ Build completed successfully!\n   Output: ${absoluteOutputDir}`,
    )
  })
