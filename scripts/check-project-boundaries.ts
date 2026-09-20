import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { ProjectGraph, ProjectGraphProjectNode } from "@nx/devkit"
import { createProjectGraphAsync, workspaceRoot } from "@nx/devkit"
import {
  validateComposedDashboardBuildInputs,
  validateConsolePluginBuildIsolation,
  validateConsolePluginDependencyGraph,
  validateDashboardDependencyFiles,
  validateDashboardDependencyGraph,
} from "../tools/project-boundaries/dashboard-dependency-boundary"
import {
  DEPENDENCY_CONSTRAINTS,
  DISTRIBUTION_TAGS,
  NON_GRAPH_DEPENDENCIES,
  PRIVATE_SOURCE_PROJECT_ROOTS,
  PUBLICATION_ALLOWLIST,
  PUBLIC_SNAPSHOT_INPUTS,
  PUBLIC_SNAPSHOT_ROOT_INPUTS,
  PUBLIC_SOURCE_PROJECT_ROOTS,
  PUBLISHABLE_PROJECTS,
  VERIFIED_BUNDLED_DEPENDENCIES,
  VISIBILITY_TAGS,
  tagsForProjectRoot,
} from "../tools/project-boundaries/policy"
import {
  type ReferenceFile,
  hasPackageReference,
  isNonGraphDependencyFile,
  withoutComments,
} from "../tools/project-boundaries/reference-scanner"

type BoundaryNode = Pick<ProjectGraphProjectNode, "name"> & {
  data: Pick<ProjectGraphProjectNode["data"], "root" | "tags">
}

const tagsInDimension = (
  node: BoundaryNode,
  dimension: readonly string[],
): string[] => (node.data.tags ?? []).filter((tag) => dimension.includes(tag))

export const validateProjectGraph = (graph: ProjectGraph): string[] => {
  const errors: string[] = []

  for (const node of Object.values(graph.nodes)) {
    const visibility = tagsInDimension(node, VISIBILITY_TAGS)
    const distribution = tagsInDimension(node, DISTRIBUTION_TAGS)

    if (visibility.length !== 1) {
      errors.push(
        `${node.name} (${node.data.root}) must have exactly one visibility tag; found ${visibility.length === 0 ? "none" : visibility.join(", ")}. Add the project to the reviewed inventory in tools/project-boundaries/policy.ts.`,
      )
    }
    if (distribution.length !== 1) {
      errors.push(
        `${node.name} (${node.data.root}) must have exactly one distribution tag; found ${distribution.length === 0 ? "none" : distribution.join(", ")}. Add the project to the reviewed inventory in tools/project-boundaries/policy.ts.`,
      )
    }
    if (
      visibility.includes("visibility:private-source") &&
      distribution.includes("distribution:publishable")
    ) {
      errors.push(
        `${node.name} is private source but publishable. Move it to public source or mark it workspace-internal.`,
      )
    }
  }

  for (const [sourceName, dependencies] of Object.entries(graph.dependencies)) {
    const source = graph.nodes[sourceName]
    if (!source) continue

    for (const dependency of dependencies) {
      const target = graph.nodes[dependency.target]
      if (!target) continue

      for (const constraint of DEPENDENCY_CONSTRAINTS) {
        if (!(source.data.tags ?? []).includes(constraint.sourceTag)) continue

        const allowed = constraint.allowedTargetTags.some((tag) =>
          (target.data.tags ?? []).includes(tag),
        )
        if (!allowed) {
          errors.push(
            `${source.name} -> ${target.name} (${dependency.type}) violates ${constraint.sourceTag} -> [${constraint.allowedTargetTags.join(", ")}]. ${constraint.remediation}`,
          )
        }
      }
    }
  }

  return errors
}

const readPackageMetadata = (
  root: string,
): { readonly name: string | undefined; readonly private: boolean } => {
  const manifestPath = join(workspaceRoot, root, "package.json")
  if (!existsSync(manifestPath)) return { name: undefined, private: true }

  const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"))
  if (typeof manifest !== "object" || manifest === null) {
    return { name: undefined, private: false }
  }

  return {
    name:
      "name" in manifest && typeof manifest.name === "string"
        ? manifest.name
        : undefined,
    private: "private" in manifest && manifest.private === true,
  }
}

export const validatePublicationStatus = ({
  projectName,
  root,
  distributionTags,
  packagePrivate,
  packageName,
  plannedPackageName,
}: {
  projectName: string
  root: string
  distributionTags: readonly string[]
  packagePrivate: boolean
  packageName?: string
  plannedPackageName?: string
}): string | undefined => {
  if (
    distributionTags.includes("distribution:workspace-internal") &&
    !packagePrivate
  ) {
    return `${projectName} (${root}) is workspace-internal but its package.json is publishable. Add "private": true; only reviewed publication identities are allowed.`
  }

  if (
    distributionTags.includes("distribution:publishable") &&
    !packagePrivate &&
    packageName !== plannedPackageName
  ) {
    return `${projectName} (${root}) is publishable as ${packageName ?? "an unnamed package"}, but its only approved publication identity is ${plannedPackageName ?? "not configured"}.`
  }

  return undefined
}

export const validateReleaseDependencies = ({
  graph,
  sourceName,
  packagePrivate,
  bundledDependencies = [],
}: {
  graph: ProjectGraph
  sourceName: string
  packagePrivate: boolean
  bundledDependencies?: readonly string[]
}): string[] => {
  if (packagePrivate) return []

  const source = graph.nodes[sourceName]
  if (!source?.data.tags?.includes("distribution:publishable")) return []
  const bundled = new Set(bundledDependencies)

  return (graph.dependencies[sourceName] ?? []).flatMap((dependency) => {
    const target = graph.nodes[dependency.target]
    return target?.data.tags?.includes("distribution:workspace-internal") &&
      !bundled.has(dependency.target)
      ? [
          `${sourceName} cannot be published while it depends on workspace-internal project ${dependency.target} (${dependency.type}). Publish the dependency or explicitly configure and verify bundling before making the package non-private.`,
        ]
      : []
  })
}

export const validatePathDependency = ({
  source,
  target,
  kind,
  sourcePath,
}: {
  source: BoundaryNode
  target: BoundaryNode
  kind: string
  sourcePath: string
}): string | undefined =>
  source.data.tags?.includes("visibility:public-source") &&
  target.data.tags?.includes("visibility:private-source")
    ? `${source.name} -> ${target.name} (${kind} at ${sourcePath}) violates visibility:public-source -> visibility:private-source. Replace the path with a public contract.`
    : undefined

const isUnsafeSnapshotInput = (input: string): boolean =>
  input === "." || input.includes("*") || input.startsWith("!")

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export const validateNonGraphReferenceFiles = ({
  graph,
  files,
}: {
  graph: ProjectGraph
  files: ReadonlyArray<{ readonly path: string; readonly content: string }>
}): string[] => {
  const publicNodes = Object.values(graph.nodes).filter((node) =>
    node.data.tags?.includes("visibility:public-source"),
  )
  const privateNodes = Object.values(graph.nodes).filter((node) =>
    node.data.tags?.includes("visibility:private-source"),
  )

  return files.flatMap((file) => {
    if (!isNonGraphDependencyFile(file.path)) return []

    const source = publicNodes.find(
      (node) =>
        file.path === node.data.root ||
        file.path.startsWith(`${node.data.root}/`),
    )
    if (!source) return []

    const content = withoutComments(file.content)
    return privateNodes.flatMap((target) => {
      const configurationLike =
        /(^|\/)(?:Dockerfile(?:\.[^/]*)?|docker-compose\.ya?ml|package\.json|project\.json|tsconfig(?:\.[^/]*)?\.json)$/.test(
          file.path,
        ) || /(?:\.config\.[cm]?[jt]s|\.sh)$/.test(file.path)
      const exactRelativePath = new RegExp(
        String.raw`(?:\.\.?\/)+${escapeRegExp(target.data.root)}(?=["'\x60])`,
      ).test(content)
      const references = [
        ...(hasPackageReference(content, target.name) ? [target.name] : []),
        ...(content.includes(`${target.data.root}/`) ||
        exactRelativePath ||
        (configurationLike && content.includes(target.data.root))
          ? [target.data.root]
          : []),
      ]
      return references.length > 0
        ? [
            `${source.name} -> ${target.name} (non-graph reference in ${file.path}: ${references.join(", ")}) violates visibility:public-source -> visibility:private-source. Replace it with public composition or move the referencing file to private source.`,
          ]
        : []
    })
  })
}

const RUNTIME_HOST_ROOTS = ["runtime/local", "runtime/aws"] as const
const FORBIDDEN_RUNTIME_HOST_PLUGINS = [
  {
    name: "Docker",
    packageName: "@processfocus/plugin-docker",
    root: "plugins/docker",
    remediation:
      "Depend on @processfocus/runtime executor and file-resolution host contracts instead.",
  },
  {
    name: "Google Drive",
    packageName: "@processfocus/plugin-google-drive",
    root: "plugins/google-drive",
    remediation:
      "Load its walker and browser implementation from the organisation artifact instead.",
  },
  {
    name: "AWS Lambda",
    packageName: "@processfocus/plugin-aws-lambda",
    root: "plugins/aws",
    remediation:
      "Load the implementation from the organisation artifact instead.",
  },
  {
    name: "Xero",
    packageName: "@processfocus/plugin-xero",
    root: "plugins/xero",
    remediation:
      "Load the implementation from the organisation artifact instead.",
  },
  {
    name: "Resend",
    packageName: "@processfocus/plugin-resend",
    root: "plugins/resend",
    remediation:
      "Depend on @processfocus/runtime server-plugin and webhook callback contracts instead.",
  },
] as const

interface ForbiddenRuntimeHostPlugin {
  readonly name: string
  readonly packageName: string
  readonly root: string
  readonly remediation: string
}

const containsPluginReference = (
  value: unknown,
  plugin: ForbiddenRuntimeHostPlugin,
): boolean => {
  if (typeof value === "string") {
    return (
      value === plugin.packageName ||
      value.startsWith(`${plugin.packageName}:`) ||
      value.includes(plugin.root)
    )
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsPluginReference(entry, plugin))
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some((entry) =>
      containsPluginReference(entry, plugin),
    )
  }
  return false
}

const isPrivateConsumerPluginPackCheck = (
  dependency: unknown,
  plugin: ForbiddenRuntimeHostPlugin,
): boolean =>
  typeof dependency === "object" &&
  dependency !== null &&
  !Array.isArray(dependency) &&
  "target" in dependency &&
  dependency.target === "pack-check" &&
  "projects" in dependency &&
  Array.isArray(dependency.projects) &&
  dependency.projects.includes(plugin.packageName)

const hasPluginProjectDependency = (
  content: string,
  plugin: ForbiddenRuntimeHostPlugin,
): boolean => {
  let configuration: unknown
  try {
    configuration = JSON.parse(content)
  } catch {
    return (
      hasPackageReference(content, plugin.packageName) ||
      content.includes(plugin.root)
    )
  }

  if (
    typeof configuration !== "object" ||
    configuration === null ||
    Array.isArray(configuration)
  ) {
    return false
  }

  if (
    "implicitDependencies" in configuration &&
    containsPluginReference(configuration.implicitDependencies, plugin)
  ) {
    return true
  }

  const targets = "targets" in configuration ? configuration.targets : null
  if (typeof targets !== "object" || targets === null) return false

  return Object.entries(targets).some(([targetName, target]) => {
    if (
      typeof target !== "object" ||
      target === null ||
      !("dependsOn" in target)
    ) {
      return false
    }
    if (targetName !== "private-consumer") {
      return containsPluginReference(target.dependsOn, plugin)
    }

    // This exact edge verifies the packed public release candidate, including
    // organisation-owned plugins. It is not a runtime-host dependency.
    return (
      !Array.isArray(target.dependsOn) ||
      target.dependsOn.some(
        (dependency) =>
          containsPluginReference(dependency, plugin) &&
          !isPrivateConsumerPluginPackCheck(dependency, plugin),
      )
    )
  })
}

export const isRuntimeHostDependencyFile = (path: string): boolean =>
  RUNTIME_HOST_ROOTS.some((root) => path.startsWith(`${root}/`)) &&
  (isNonGraphDependencyFile(path) ||
    /(^|\/)(?:test|tests)\/.*\.[cm]?[jt]sx?$|\.(?:spec|test)\.[cm]?[jt]sx?$/.test(
      path,
    ))

/**
 * Runtime hosts may package the public release candidate from project tooling,
 * but their manifests, TypeScript implementation, and TypeScript project
 * references must depend only on the provider-neutral runtime contract.
 */
export const validateRuntimeHostDependencyFiles = (
  files: ReadonlyArray<ReferenceFile>,
): string[] =>
  files.flatMap((file) => {
    const runtimeRoot = RUNTIME_HOST_ROOTS.find((root) =>
      file.path.startsWith(`${root}/`),
    )
    if (!runtimeRoot) return []

    const content = withoutComments(file.content)
    const discoveredPackages = [
      ...content.matchAll(/@processfocus\/plugin-[a-z0-9-]+|@pf\/cloud-org/g),
    ].map((match) => match[0])
    const plugins = [
      ...FORBIDDEN_RUNTIME_HOST_PLUGINS,
      ...[...new Set(discoveredPackages)]
        .filter(
          (packageName) =>
            !FORBIDDEN_RUNTIME_HOST_PLUGINS.some(
              (plugin) => plugin.packageName === packageName,
            ),
        )
        .map((packageName) => ({
          name: packageName,
          packageName,
          root:
            packageName === "@pf/cloud-org"
              ? "cloud/org"
              : `plugins/${packageName.slice("@processfocus/plugin-".length)}`,
          remediation:
            "Load implementations from the organisation artifact instead.",
        })),
    ]
    return plugins.flatMap((plugin) => {
      const hasConcreteDependency = file.path.endsWith("/project.json")
        ? hasPluginProjectDependency(content, plugin)
        : hasPackageReference(content, plugin.packageName) ||
          content.includes(plugin.root)
      return hasConcreteDependency
        ? [
            `${runtimeRoot} has a concrete ${plugin.name} plugin dependency in ${file.path}. ${plugin.remediation}`,
          ]
        : []
    })
  })

const EXECUTOR_HOST_GENERIC_ROOTS = [
  "packages/process/src/",
  "packages/runtime/src/",
  "plugins/docker/src/",
  "runtime/aws/src/constructs/",
  "runtime/aws/src/handlers/",
  "runtime/aws/src/services/",
  "runtime/aws/src/stacks/",
  "runtime/aws/src/utils/",
] as const

const CLOUD_ORG_EXECUTOR_IMPLEMENTATION_TOKENS = [
  "cloud-org/project-deploy",
  "cloud-org/environment-destroy",
  '"deploy-project"',
  '"destroy-project-environment"',
  "pf-console-customer-deploy-role",
  "parameter/pf-{{projectNumber}}/env/{{environmentName}}",
  "parameter/pf-{{projectNumber}}/stage/{{stageName}}",
  "parameter/turso/*",
  "parameter/otel/*",
  "parameter/route53/app/*",
  "parameter/cdk-bootstrap/hnb659fds/version",
  "cloudformation:DeleteStack",
  "cdk-hnb659fds-*-role",
  "function:pf-{{projectNumber}}-{{environmentName}}",
] as const

/** Keep cloud-org executor identities and target policy out of generic seams. */
export const validateExecutorDescriptorOwnership = (
  files: ReadonlyArray<ReferenceFile>,
): string[] =>
  files.flatMap((file) => {
    if (
      !EXECUTOR_HOST_GENERIC_ROOTS.some((root) => file.path.startsWith(root))
    ) {
      return []
    }

    return CLOUD_ORG_EXECUTOR_IMPLEMENTATION_TOKENS.flatMap((token) =>
      file.content.includes(token)
        ? [
            `${file.path} contains cloud-org executor implementation token ${token}. Keep descriptor identity, target policy, and executor-specific configuration in cloud/org/src/executor-descriptors.ts.`,
          ]
        : [],
    )
  })

const repositoryFiles = (
  include: (path: string) => boolean = isNonGraphDependencyFile,
): ReadonlyArray<ReferenceFile> => {
  const result = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    { cwd: workspaceRoot, encoding: "utf8" },
  )
  if (result.status !== 0) {
    throw new Error(result.stderr || "Failed to list repository files")
  }

  return result.stdout
    .split("\n")
    .filter((path) => path.length > 0)
    .filter(include)
    .filter((path) => existsSync(join(workspaceRoot, path)))
    .map((path) => ({
      path,
      content: readFileSync(join(workspaceRoot, path), "utf8"),
    }))
}

export const validateOrganisationPluginModel = (
  files: ReadonlyArray<ReferenceFile>,
): string[] =>
  files.flatMap((file) => {
    if (
      /\.md$/.test(file.path) ||
      /(?:spec|test)\.[cm]?[jt]sx?$/.test(file.path) ||
      file.path === "scripts/check-project-boundaries.ts"
    )
      return []
    return /trusted-frontend-plugin|PF_TRUSTED_FRONTEND_PLUGIN_CATALOG|trusted-main-realm|TrustedFrontendPlugin|trustedFrontendPlugin/.test(
      `${file.path}\n${file.content}`,
    )
      ? [
          `${file.path} retains the removed trusted plugin model. Use organisation artifacts and the versioned host contract.`,
        ]
      : []
  })

export const validatePublicationAllowlistUniqueness = (
  allowlist: readonly string[],
): string[] =>
  new Set(allowlist).size === allowlist.length
    ? []
    : ["The publication allowlist must not contain duplicate packages."]

export const validateInventory = (graph: ProjectGraph): string[] => {
  const errors: string[] = []
  const files = repositoryFiles()
  errors.push(
    ...validateOrganisationPluginModel(
      repositoryFiles(
        (path) =>
          /\.(?:json|ya?ml|[cm]?[jt]sx?|sh)$/.test(path) ||
          path.endsWith("Dockerfile"),
      ),
    ),
  )
  const runtimeHostFiles = repositoryFiles(isRuntimeHostDependencyFile)
  const executorHostFiles = repositoryFiles((path) =>
    EXECUTOR_HOST_GENERIC_ROOTS.some((root) => path.startsWith(root)),
  )
  const allowlist = new Set<string>(PUBLICATION_ALLOWLIST)
  const roots = new Set(
    Object.values(graph.nodes).map((node) => node.data.root),
  )

  errors.push(...validatePublicationAllowlistUniqueness(PUBLICATION_ALLOWLIST))

  for (const [root, packageName] of Object.entries(PUBLISHABLE_PROJECTS)) {
    if (!allowlist.has(packageName)) {
      errors.push(`${root} maps to non-allowlisted publication ${packageName}.`)
    }
  }

  for (const node of Object.values(graph.nodes)) {
    const packageMetadata = readPackageMetadata(node.data.root)
    const plannedPackageName = Object.entries(PUBLISHABLE_PROJECTS).find(
      ([root]) => root === node.data.root,
    )?.[1]
    const publicationError = validatePublicationStatus({
      projectName: node.name,
      root: node.data.root,
      distributionTags: tagsForProjectRoot(node.data.root) ?? [],
      packagePrivate: packageMetadata.private,
      packageName: packageMetadata.name,
      plannedPackageName,
    })
    if (publicationError) errors.push(publicationError)
    errors.push(
      ...validateReleaseDependencies({
        graph,
        sourceName: node.name,
        packagePrivate: packageMetadata.private,
        bundledDependencies:
          VERIFIED_BUNDLED_DEPENDENCIES[
            node.name as keyof typeof VERIFIED_BUNDLED_DEPENDENCIES
          ],
      }),
    )
  }

  const publicSnapshot = existsSync(join(workspaceRoot, "public-source.json"))
  if (publicSnapshot) {
    for (const root of PRIVATE_SOURCE_PROJECT_ROOTS) {
      if (existsSync(join(workspaceRoot, root)))
        errors.push(`Public snapshot contains private project ${root}.`)
    }
  }
  for (const root of [
    ...PUBLIC_SOURCE_PROJECT_ROOTS,
    ...(publicSnapshot ? [] : PRIVATE_SOURCE_PROJECT_ROOTS),
  ]) {
    if (!roots.has(root)) {
      errors.push(
        `The project inventory contains stale root ${root}. Remove or update it.`,
      )
    }
  }

  for (const input of PUBLIC_SNAPSHOT_ROOT_INPUTS) {
    if (isUnsafeSnapshotInput(input)) {
      errors.push(
        `Public snapshot input ${input} is not an explicit positive path. List files or reviewed directories without root copies, globs, or exclusions.`,
      )
    } else if (!existsSync(join(workspaceRoot, input))) {
      errors.push(`Public snapshot input ${input} does not exist.`)
    }
  }

  if (
    new Set<string>(PUBLIC_SNAPSHOT_INPUTS).size !==
    PUBLIC_SNAPSHOT_INPUTS.length
  ) {
    errors.push("Public snapshot inputs must be unique.")
  }

  for (const dependency of NON_GRAPH_DEPENDENCIES) {
    if (
      publicSnapshot &&
      PRIVATE_SOURCE_PROJECT_ROOTS.some((root) =>
        dependency.source.startsWith(`${root}/`),
      )
    )
      continue
    if (!existsSync(join(workspaceRoot, dependency.source))) {
      errors.push(
        `Non-graph ${dependency.kind} inventory has missing source ${dependency.source}.`,
      )
      continue
    }

    const sourceNode = Object.values(graph.nodes).find(
      (node) =>
        dependency.source === node.data.root ||
        dependency.source.startsWith(`${node.data.root}/`),
    )
    const targetNode = Object.values(graph.nodes).find(
      (node) => node.data.root === dependency.targetRoot,
    )
    if (!sourceNode || !targetNode) {
      errors.push(
        `Non-graph ${dependency.kind} ${dependency.source} -> ${dependency.targetRoot} does not resolve to two inventoried Nx projects.`,
      )
      continue
    }

    const pathError = validatePathDependency({
      source: sourceNode,
      target: targetNode,
      kind: dependency.kind,
      sourcePath: dependency.source,
    })
    if (pathError) errors.push(pathError)
  }

  errors.push(
    ...validateNonGraphReferenceFiles({
      graph,
      files,
    }),
  )
  errors.push(...validateRuntimeHostDependencyFiles(runtimeHostFiles))
  errors.push(...validateExecutorDescriptorOwnership(executorHostFiles))
  errors.push(
    ...validateDashboardDependencyFiles({
      graph,
      files,
    }),
  )

  const biomeConfiguration = readFileSync(
    join(workspaceRoot, "biome.json"),
    "utf8",
  )
  for (const node of Object.values(graph.nodes)) {
    if (!node.data.tags?.includes("visibility:private-source")) continue

    for (const restrictedPath of [node.name, `${node.name}/**`]) {
      if (!biomeConfiguration.includes(JSON.stringify(restrictedPath))) {
        errors.push(
          `Biome restrictions are missing private project import ${restrictedPath}. Derive the public-source override from the Nx inventory.`,
        )
      }
    }
  }

  return errors
}

if (import.meta.main) {
  const graph = await createProjectGraphAsync()
  const awsProject = join(workspaceRoot, "runtime/aws/project.json")
  const errors = [
    ...validateProjectGraph(graph),
    ...validateDashboardDependencyGraph(graph),
    ...validateConsolePluginDependencyGraph(graph),
    ...(existsSync(awsProject)
      ? validateComposedDashboardBuildInputs(
          JSON.parse(
            readFileSync(
              join(workspaceRoot, "runtime/aws/project.json"),
              "utf8",
            ),
          ),
        )
      : []),
    ...(existsSync(awsProject)
      ? validateConsolePluginBuildIsolation(
          JSON.parse(
            readFileSync(
              join(workspaceRoot, "runtime/aws/project.json"),
              "utf8",
            ),
          ),
        )
      : []),
    ...validateInventory(graph),
  ]

  if (errors.length > 0) {
    console.error(`Project boundary check failed:\n\n${errors.join("\n")}`)
    process.exitCode = 1
  } else {
    console.info(
      `Project boundary check passed for ${Object.keys(graph.nodes).length} projects.`,
    )
  }
}
