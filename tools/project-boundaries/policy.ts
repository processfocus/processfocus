export const VISIBILITY_TAGS = [
  "visibility:public-source",
  "visibility:private-source",
] as const

export const DISTRIBUTION_TAGS = [
  "distribution:publishable",
  "distribution:workspace-internal",
] as const

export type VisibilityTag = (typeof VISIBILITY_TAGS)[number]
export type DistributionTag = (typeof DISTRIBUTION_TAGS)[number]

// This is also the positive allowlist of Nx project roots copied to a public
// source snapshot. New projects remain unclassified until explicitly reviewed.
export const PUBLIC_SOURCE_PROJECT_ROOTS = [
  "apps/frontend",
  "apps/frontend-e2e",
  "apps/graphql-e2e",
  "apps/www",
  "cli/generate-rxdb",
  "cli/generate-triggers",
  "cli/pfcli",
  "cli/pforg",
  "cli/xplain2drizzle",
  "examples/demo",
  "examples/on-boarding",
  "fixtures/external-authoring",
  "fixtures/external-plugins/aws-lambda",
  "fixtures/external-plugins/docker",
  "fixtures/external-plugins/google-drive",
  "fixtures/external-plugins/posthog",
  "fixtures/external-plugins/resend",
  "fixtures/external-plugins/xero",
  "packages/auth-api",
  "packages/auth-config",
  "packages/auth-local-cedar",
  "packages/auth-policy",
  "packages/auth-session",
  "packages/aws-common",
  "packages/business-calendar",
  "packages/business-metrics",
  "packages/db-info",
  "packages/db-schema",
  "packages/document-store-service",
  "packages/drizzle-postgres",
  "packages/drizzle-sqlite",
  "packages/effect-json-logger",
  "packages/form",
  "packages/form-client-representation",
  "packages/form-rule",
  "packages/form-schema",
  "packages/form-submission-schema",
  "packages/frontend-endpoints",
  "packages/frontend-manifest",
  "packages/frontend-plugin-host",
  "packages/graphql-api",
  "packages/graphql-db-operations",
  "packages/graphql-schema",
  "packages/hosting-contract",
  "packages/job-handler",
  "packages/layer-sqlite-bun",
  "packages/layer-turso-cloud",
  "packages/layer-turso-local",
  "packages/openauth",
  "packages/org-to-db",
  "packages/org-to-graphql-schema",
  "packages/postgres-operations",
  "packages/postgres-queue-service",
  "packages/process",
  "packages/process-test-runner",
  "packages/queue-service",
  "packages/request-time",
  "packages/runtime",
  "packages/sdk",
  "packages/rxdb-collections",
  "packages/service-drizzle-postgres",
  "packages/service-drizzle-sqlite",
  "packages/shadcn-components",
  "packages/sqlite-operations",
  "packages/sqlite-queue-service",
  "packages/todo-summary",
  "packages/usage-costs",
  "packages/xplain-ddl",
  "plugins/aws",
  "plugins/docker",
  "plugins/google-drive",
  "plugins/posthog",
  "plugins/resend",
  "plugins/xero",
  "runtime/local",
  "tools/eslint-react-compiler",
] as const

export const PRIVATE_SOURCE_PROJECT_ROOTS = [
  "cloud/access-review-inventory-role",
  "cloud/access-review-management-role",
  "cloud/bootstrap-aws-account",
  "cloud/management-billing-role",
  "cloud/org",
  "cloud/org/console",
  "cloud/org/console-e2e",
  "cloud/scripts",
  "examples/school",
  "examples/tbsnz",
  "fixtures/private-consumer",
  "infra/demo-lambda",
  "infra/github",
  "infra/network",
  "infra/soc2",
  "runtime/aws",
  "tools/build-tests",
  "tools/repository-tests",
  "tools/publication-tests",
] as const

export const PUBLICATION_ALLOWLIST = [
  "processfocus",
  "@processfocus/runtime",
  "@processfocus/runtime-local",
  "@processfocus/cli",
  "@processfocus/pforg",
  "@processfocus/hosting-contract",
  "@processfocus/plugin-aws-lambda",
  "@processfocus/plugin-docker",
  "@processfocus/plugin-google-drive",
  "@processfocus/plugin-posthog",
  "@processfocus/plugin-resend",
  "@processfocus/plugin-xero",
] as const

export const PUBLISHABLE_PROJECTS = {
  "packages/runtime": "@processfocus/runtime",
  "packages/sdk": "processfocus",
  "packages/hosting-contract": "@processfocus/hosting-contract",
  "runtime/local": "@processfocus/runtime-local",
  "cli/pfcli": "@processfocus/cli",
  "cli/pforg": "@processfocus/pforg",
  "plugins/aws": "@processfocus/plugin-aws-lambda",
  "plugins/docker": "@processfocus/plugin-docker",
  "plugins/google-drive": "@processfocus/plugin-google-drive",
  "plugins/posthog": "@processfocus/plugin-posthog",
  "plugins/resend": "@processfocus/plugin-resend",
  "plugins/xero": "@processfocus/plugin-xero",
} as const satisfies Partial<
  Record<
    (typeof PUBLIC_SOURCE_PROJECT_ROOTS)[number],
    (typeof PUBLICATION_ALLOWLIST)[number]
  >
>

export const VERIFIED_BUNDLED_DEPENDENCIES = {
  processfocus: [
    "@pf/auth-config",
    "@pf/business-calendar",
    "@pf/form-rule",
    "@pf/form-schema",
    "@pf/frontend-manifest",
    "@pf/frontend-plugin-host",
    "@pf/process",
  ],
  "@processfocus/cli": [
    "@pf/auth-api",
    "@pf/auth-config",
    "@pf/auth-local-cedar",
    "@pf/auth-policy",
    "@pf/auth-session",
    "@pf/db-info",
    "@pf/drizzle-sqlite",
    "@pf/frontend-endpoints",
    "@pf/graphql-db-operations",
    "@pf/layer-turso-cloud",
    "@pf/layer-turso-local",
    "@pf/openauth",
    "@pf/org-to-db",
    "@pf/org-to-graphql-schema",
    "@pf/process",
    "@pf/request-time",
    "@pf/service-drizzle-sqlite",
    "@pf/sqlite-operations",
  ],
  "@processfocus/runtime-local": [
    "@pf/auth-api",
    "@pf/auth-config",
    "@pf/auth-local-cedar",
    "@pf/auth-policy",
    "@pf/auth-session",
    "@pf/db-info",
    "@pf/document-store-service",
    "@pf/drizzle-postgres",
    "@pf/drizzle-sqlite",
    "@pf/form-schema",
    "@pf/frontend-endpoints",
    "@pf/graphql-api",
    "@pf/graphql-db-operations",
    "@pf/graphql-schema",
    "@pf/job-handler",
    "@pf/layer-turso-cloud",
    "@pf/layer-turso-local",
    "@pf/openauth",
    "@pf/org-to-db",
    "@pf/org-to-graphql-schema",
    "@pf/postgres-operations",
    "@pf/process",
    "@pf/request-time",
    "@pf/service-drizzle-postgres",
    "@pf/service-drizzle-sqlite",
    "@pf/sqlite-operations",
    "@pf/sqlite-queue-service",
    "@pf/todo-summary",
  ],
} as const

export const PUBLIC_SNAPSHOT_ROOT_INPUTS = [
  ".github/workflows/public-source.yml",
  ".github/workflows/public-release.yml",
  "docs/public-release.md",
  "LICENSE.md",
  ".gitignore",
  "CONTEXT-MAP.md",
  "docs/frontend/dashboard-distributions.md",
  "README.md",
  "biome.json",
  "bun.lock",
  "bunfig.toml",
  "mise.toml",
  "knip.json",
  "nx.json",
  "package.json",
  "scripts/check-project-boundaries.test.ts",
  "scripts/public-source-snapshot.test.ts",
  "scripts/check-project-boundaries.ts",
  "scripts/clean-package-distribution.ts",
  "scripts/create-public-source-snapshot.ts",
  "scripts/prepare-public-source-workspace.ts",
  "scripts/build-public-dashboard.sh",
  "scripts/ci-frontend-build-lifecycle.sh",
  "scripts/ci-frontend-build-database.sh",
  "scripts/finalize-plugin-distribution.ts",
  "scripts/finalize-sdk-distribution.ts",
  "scripts/nx-quiet.ts",
  "scripts/verify-distribution.ts",
  "scripts/verify-local-dashboard.ts",
  "scripts/dashboard-package-policy.ts",
  "scripts/dashboard-package-policy.test.ts",
  "scripts/verify-external-authoring.ts",
  "scripts/verify-external-plugins.ts",
  "scripts/public-release.ts",
  "scripts/public-release.test.ts",
  "scripts/check-public-source.ts",
  "tools/public-release/policy.ts",
  "tools/project-boundaries/dashboard-dependency-boundary.ts",
  "tools/project-boundaries/nx-plugin.ts",
  "tools/project-boundaries/policy.ts",
  "tools/project-boundaries/reference-scanner.ts",
  "tsconfig.base.json",
  "tsconfig.json",
  "vitest.config.ts",
] as const

export const PUBLIC_SNAPSHOT_INPUTS = [
  ...PUBLIC_SNAPSHOT_ROOT_INPUTS,
  ...PUBLIC_SOURCE_PROJECT_ROOTS,
] as const

export const DEPENDENCY_CONSTRAINTS = [
  {
    sourceTag: "visibility:public-source",
    allowedTargetTags: ["visibility:public-source"],
    remediation:
      "Move the dependency to public source or depend on a released public contract.",
  },
  {
    sourceTag: "visibility:private-source",
    allowedTargetTags: VISIBILITY_TAGS,
    remediation: "No visibility change is required.",
  },
  {
    sourceTag: "distribution:publishable",
    allowedTargetTags: DISTRIBUTION_TAGS,
    remediation:
      "Publish or bundle the dependency before the package is released.",
  },
  {
    sourceTag: "distribution:workspace-internal",
    allowedTargetTags: DISTRIBUTION_TAGS,
    remediation: "No distribution change is required.",
  },
] as const

export const NON_GRAPH_DEPENDENCIES = [
  {
    kind: "command",
    source: "runtime/aws/project.json",
    targetRoot: "apps/frontend",
  },
  {
    kind: "generated-code-input",
    source: "runtime/aws/project.json",
    targetRoot: "packages/graphql-schema",
  },
  {
    kind: "filesystem-path",
    source: "runtime/aws/open-next.config.ts",
    targetRoot: "apps/frontend",
  },
  {
    kind: "command",
    source: "runtime/local/project.json",
    targetRoot: "cli/pfcli",
  },
  {
    kind: "filesystem-path",
    source: "cli/pfcli/src/utils/bundled-db-import.ts",
    targetRoot: "packages/layer-turso-cloud",
  },
  {
    kind: "docker-context",
    source: "cloud/org/src/docker/deploy-project/Dockerfile",
    targetRoot: "cloud/org",
  },
] as const

const publicRoots = new Set<string>(PUBLIC_SOURCE_PROJECT_ROOTS)
const privateRoots = new Set<string>(PRIVATE_SOURCE_PROJECT_ROOTS)
const publishableRoots = new Set<string>(Object.keys(PUBLISHABLE_PROJECTS))

export const tagsForProjectRoot = (
  root: string,
): readonly [VisibilityTag, DistributionTag] | undefined => {
  const visibility = publicRoots.has(root)
    ? "visibility:public-source"
    : privateRoots.has(root)
      ? "visibility:private-source"
      : undefined

  if (!visibility) {
    return undefined
  }

  return [
    visibility,
    publishableRoots.has(root)
      ? "distribution:publishable"
      : "distribution:workspace-internal",
  ]
}
