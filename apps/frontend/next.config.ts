import { existsSync } from "node:fs"
import { join, relative } from "node:path"
import bundleAnalyzer from "@next/bundle-analyzer"
import type { NextConfig } from "next"
import {
  buildEmbedFrameAncestorsPolicy,
  getEmbedRoutePath,
} from "./lib/embed-manifest"
import { getEmbedManifestEntries } from "./lib/embed-manifest-store"
import packageJson from "./package.json" with { type: "json" }

const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env["ANALYZE"] === "true",
})

const reactCompilerPanicThreshold =
  process.env["REACT_COMPILER_PANIC_THRESHOLD"] === "all_errors"
    ? "all_errors"
    : "none"
const configuredBuildId = process.env["PF_NEXT_BUILD_ID"]?.trim() || undefined

const workspaceRoot =
  process.env["NX_WORKSPACE_ROOT"] ?? join(process.cwd(), "../..")
const localOrganisationPluginModule = join(
  workspaceRoot,
  "apps/frontend/lib/organisation-plugin-loaders.ts",
)
const generatedOrganisationPluginModule = join(
  workspaceRoot,
  "apps/frontend/lib/generated/organisation-plugin-loaders.tsx",
)
const localOrganisationPluginPreparationModule = join(
  workspaceRoot,
  "apps/frontend/lib/organisation-plugin-preparation.ts",
)
const generatedOrganisationPluginPreparationModule = join(
  workspaceRoot,
  "apps/frontend/lib/generated/organisation-plugin-preparation.ts",
)
const organisationPluginModule = existsSync(generatedOrganisationPluginModule)
  ? generatedOrganisationPluginModule
  : localOrganisationPluginModule
const organisationPluginModuleFromFrontend = relative(
  join(workspaceRoot, "apps/frontend"),
  organisationPluginModule,
)
const organisationPluginPreparationModule = existsSync(
  generatedOrganisationPluginPreparationModule,
)
  ? generatedOrganisationPluginPreparationModule
  : localOrganisationPluginPreparationModule
const organisationPluginPreparationModuleFromFrontend = relative(
  join(workspaceRoot, "apps/frontend"),
  organisationPluginPreparationModule,
)
const turbopackOrganisationPluginModule =
  organisationPluginModuleFromFrontend.startsWith(".")
    ? organisationPluginModuleFromFrontend
    : `./${organisationPluginModuleFromFrontend}`
const turbopackOrganisationPluginPreparationModule =
  organisationPluginPreparationModuleFromFrontend.startsWith(".")
    ? organisationPluginPreparationModuleFromFrontend
    : `./${organisationPluginPreparationModuleFromFrontend}`

/**
 * @type {import("@nx/next/plugins/with-nx").WithNxOptions}
 **/
const nextConfig: NextConfig = {
  ...(configuredBuildId === undefined
    ? {}
    : { generateBuildId: async () => configuredBuildId }),
  env: {
    NEXT_PUBLIC_PROCESS_FOCUS_VERSION: packageJson.version,
  },
  cacheComponents: true,
  partialPrefetching: true,
  reactCompiler: {
    compilationMode: "infer",
    panicThreshold: reactCompilerPanicThreshold,
  },
  experimental: {
    // Only disposable E2E builds expose the Navigation Inspector testing API.
    exposeTestingApiInProductionBuild: process.env["PF_INSTANT_E2E"] === "1",
    turbopackFileSystemCacheForDev: true,
  },
  turbopack: {
    resolveAlias: {
      // Cedar's CommonJS nodejs entry reads the wasm file from __dirname.
      // In Turbopack cold compiles that gets externalized under a hashed
      // package name, which fails on the first request from a clean .next.
      "@cedar-policy/cedar-wasm/nodejs": "@cedar-policy/cedar-wasm",
      "@/lib/organisation-plugin-loaders": turbopackOrganisationPluginModule,
      "@/lib/organisation-plugin-preparation":
        turbopackOrganisationPluginPreparationModule,
    },
  },

  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "lh3.googleusercontent.com",
        pathname: "/**",
      },
    ],
  },

  webpack: (config, { isServer }) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      "@cedar-policy/cedar-wasm/nodejs": "@cedar-policy/cedar-wasm",
      "@/lib/organisation-plugin-loaders": organisationPluginModule,
      "@/lib/organisation-plugin-preparation":
        organisationPluginPreparationModule,
    }

    // Add WASM support for Cedar policy engine (server-side only)
    if (isServer) {
      config.experiments = {
        ...config.experiments,
        asyncWebAssembly: true,
      }

      // Handle .wasm files
      config.module.rules.push({
        test: /\.wasm$/,
        type: "asset/resource",
      })
    }

    return config
  },
  output: "standalone",
  headers: async () => [
    {
      source: "/:path*",
      headers: [
        {
          key: "X-Content-Type-Options",
          value: "nosniff",
        },
      ],
    },
    // Public Invitation Registration page: no store, no referrer, strict CSP.
    // 'unsafe-inline' script is required for the early fragment-scrub bootstrap.
    {
      source: "/register/passkey",
      headers: [
        {
          key: "Cache-Control",
          value: "no-store",
        },
        {
          key: "Referrer-Policy",
          value: "no-referrer",
        },
        {
          key: "Content-Security-Policy",
          value: [
            "default-src 'self'",
            "base-uri 'self'",
            "form-action 'self'",
            "frame-ancestors 'none'",
            "img-src 'self' data:",
            "style-src 'self' 'unsafe-inline'",
            "script-src 'self' 'unsafe-inline'",
            "connect-src 'self'",
            "object-src 'none'",
          ].join("; "),
        },
      ],
    },
    // Browser boot health surface: probes must always observe fresh boot state.
    {
      source: "/_pf/health",
      headers: [
        {
          key: "Cache-Control",
          value: "no-store",
        },
      ],
    },
    ...getEmbedManifestEntries().flatMap((entry) =>
      [entry.processPath, entry.stepPath].map((path) => ({
        source: getEmbedRoutePath(path),
        headers: [
          {
            key: "Content-Security-Policy",
            value: buildEmbedFrameAncestorsPolicy(entry),
          },
        ],
      })),
    ),
  ],
  // this should be the path to the root of your repo, in this case
  // it's just two levels down. needed for open-next to detect that
  // it's a monorepo
  outputFileTracingRoot: join(import.meta.dirname ?? ".", "../../"),
  outputFileTracingExcludes: {
    "*": [
      "./**/*.js.map",
      "./**/*.mjs.map",
      "./**/*.cjs.map",
      "node_modules/caniuselite",
      "node_modules/esbuild",
      "node_modules/webpack",
      "node_modules/@rspack",
      "node_modules/sass",
      "node_modules/sharp",
      //"node_modules/@swc",
      "node_modules/typescript",
    ],
  },
  outputFileTracingIncludes: {
    "/*": [
      "./lib/generated/frontend-manifest.json",
      "./lib/generated/docs/**/*",
      "./public/_pf/app-icons/**/*",
      "./public/_pf/public-form-branding/**/*",
    ],
  },
  // Use this to set Nx-specific options
  // See: https://nx.dev/recipes/next/next-config-setup
  // nx: {},
}

export default withBundleAnalyzer(nextConfig)
