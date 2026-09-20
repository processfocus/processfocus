import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import type { ProjectGraph, ProjectGraphProjectNode } from "@nx/devkit"
import { parseJson, workspaceRoot } from "@nx/devkit"
import ts from "typescript"
import {
  type ReferenceFile,
  hasPackageReference,
  isNonGraphDependencyFile,
  withoutComments,
} from "./reference-scanner"

type BoundaryNode = Pick<ProjectGraphProjectNode, "name"> & {
  data: Pick<ProjectGraphProjectNode["data"], "root">
}

const isConcreteDashboardDependency = (
  node: ProjectGraphProjectNode,
): boolean =>
  node.data.root === "cloud/org" || node.data.root.startsWith("plugins/")

export const validateDashboardDependencyGraph = (
  graph: ProjectGraph,
): string[] =>
  (graph.dependencies["@pf/frontend"] ?? []).flatMap((dependency) => {
    const target = graph.nodes[dependency.target]
    return target && isConcreteDashboardDependency(target)
      ? [
          `@pf/frontend -> ${target.name} (${dependency.type}) violates the generic Dashboard boundary. Load concrete plugins from the organisation artifact.`,
        ]
      : []
  })

const isConsolePluginDependency = (node: ProjectGraphProjectNode): boolean =>
  node.data.root === "apps/frontend" ||
  node.data.root === "cloud/org" ||
  node.data.root === "packages/frontend-manifest" ||
  node.data.root === "packages/frontend-plugin-host" ||
  node.data.root.startsWith("plugins/")

export const validateConsolePluginDependencyGraph = (
  graph: ProjectGraph,
): string[] =>
  (graph.dependencies["@pf/cloud-org-console"] ?? []).flatMap((dependency) => {
    const target = graph.nodes[dependency.target]
    return target && isConsolePluginDependency(target)
      ? [
          `@pf/cloud-org-console -> ${target.name} (${dependency.type}) violates the Console isolation boundary. Keep organisation plugin composition in the Backend Dashboard build.`,
        ]
      : []
  })

const REQUIRED_COMPOSED_BUILD_INPUTS = [
  "{workspaceRoot}/apps/frontend/lib/generated/browser-plugins/**/*",
] as const

const FORBIDDEN_PRIVATE_COMPOSED_BUILD_INPUTS = [
  "{workspaceRoot}/cloud/org/frontend-plugins",
  "{workspaceRoot}/cloud/org/src/register-environment-usage-costs-client.tsx",
  "{workspaceRoot}/cloud/org/src/register-access-review-evidence-client.tsx",
] as const

export const validateComposedDashboardBuildInputs = (
  runtimeAwsProject: unknown,
): string[] => {
  const project = ensureRecord(runtimeAwsProject, "runtime/aws/project.json")
  const targets = ensureRecord(
    project["targets"],
    "runtime/aws/project.json.targets",
  )
  const buildOpennext = ensureRecord(
    targets["build-opennext"],
    "runtime/aws/project.json.targets.build-opennext",
  )
  const inputs = buildOpennext["inputs"]
  if (!Array.isArray(inputs)) {
    return [
      "@pf/runtime-aws:build-opennext must declare its generated organisation browser artifact inputs.",
    ]
  }
  const missing = REQUIRED_COMPOSED_BUILD_INPUTS.flatMap((required) =>
    inputs.some((input) => input === required)
      ? []
      : [
          `@pf/runtime-aws:build-opennext must include ${required} so staged organisation browser artifacts invalidate the composed Backend build.`,
        ],
  )
  const forbidden = FORBIDDEN_PRIVATE_COMPOSED_BUILD_INPUTS.flatMap(
    (privateInput) =>
      inputs.some(
        (input) => typeof input === "string" && input.startsWith(privateInput),
      )
        ? [
            `@pf/runtime-aws:build-opennext must consume emitted organisation browser artifacts, not private workspace input ${privateInput}.`,
          ]
        : [],
  )
  return [...missing, ...forbidden]
}

const containsPluginBuildReference = (value: unknown): boolean =>
  containsNestedString(value, (entry) =>
    [
      "PF_ORG",
      "browser-plugins",
      "frontend-manifest",
      "frontend-plugin-host",
      "prepare-build-inputs",
      "@pf/frontend",
      "apps/frontend",
    ].some((forbidden) => entry.includes(forbidden)),
  )

export const validateConsolePluginBuildIsolation = (
  runtimeAwsProject: unknown,
): string[] => {
  const project = ensureRecord(runtimeAwsProject, "runtime/aws/project.json")
  const targets = ensureRecord(
    project["targets"],
    "runtime/aws/project.json.targets",
  )
  return ["build-console-opennext", "build-console-for-opennext"].flatMap(
    (targetName) => {
      const target = ensureRecord(
        targets[targetName],
        `runtime/aws/project.json.targets.${targetName}`,
      )
      return containsPluginBuildReference(target)
        ? [
            `@pf/runtime-aws:${targetName} must not reference organisation plugin manifests, bundles, hosts, Dashboard preparation, or PF_ORG.`,
          ]
        : []
    },
  )
}

const ensureRecord = (
  value: unknown,
  path: string,
): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`)
  }
  return value
}

const containsNestedString = (
  value: unknown,
  matches: (value: string) => boolean,
): boolean => {
  if (typeof value === "string") return matches(value)
  if (Array.isArray(value)) {
    return value.some((entry) => containsNestedString(entry, matches))
  }
  if (typeof value !== "object" || value === null) return false
  return Object.entries(value).some(
    ([key, entry]) => matches(key) || containsNestedString(entry, matches),
  )
}

const containsPackageSpecifier = (
  value: unknown,
  packageName: string,
): boolean =>
  containsNestedString(
    value,
    (entry) =>
      entry === packageName ||
      entry.startsWith(`${packageName}/`) ||
      entry === `npm:${packageName}` ||
      entry.startsWith(`npm:${packageName}@`),
  )

const referencesProjectRoot = (
  sourcePath: string,
  reference: string,
  targetRoot: string,
): boolean => {
  if (!reference.startsWith(".") && !isAbsolute(reference)) return false

  const sourceDirectory = dirname(resolve(workspaceRoot, sourcePath))
  const targetDirectory = resolve(workspaceRoot, targetRoot)
  const referencedPath = resolve(sourceDirectory, reference)
  const relativeToTarget = relative(targetDirectory, referencedPath)
  return (
    relativeToTarget === "" ||
    (relativeToTarget !== ".." &&
      !relativeToTarget.startsWith(`..${sep}`) &&
      !isAbsolute(relativeToTarget))
  )
}

const containsProjectPath = (
  value: unknown,
  sourcePath: string,
  targetRoot: string,
): boolean =>
  containsNestedString(value, (entry) =>
    referencesProjectRoot(sourcePath, entry, targetRoot),
  )

const hasConfigurationReference = (
  path: string,
  content: string,
  target: BoundaryNode,
): boolean => {
  let configuration: unknown
  try {
    configuration = parseJson(content)
  } catch {
    return false
  }
  if (typeof configuration !== "object" || configuration === null) return false

  if (path.endsWith("/package.json")) {
    const dependencySections = [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ] as const
    return (
      ("imports" in configuration &&
        (containsPackageSpecifier(configuration.imports, target.name) ||
          containsProjectPath(
            configuration.imports,
            path,
            target.data.root,
          ))) ||
      dependencySections.some(
        (section) =>
          section in configuration &&
          containsPackageSpecifier(configuration[section], target.name),
      )
    )
  }
  if (!/(^|\/)tsconfig(?:\.[^/]*)?\.json$/.test(path)) return false
  if (
    "references" in configuration &&
    containsProjectPath(configuration.references, path, target.data.root)
  ) {
    return true
  }
  if (!("compilerOptions" in configuration)) return false
  const compilerOptions = configuration.compilerOptions
  if (typeof compilerOptions !== "object" || compilerOptions === null)
    return false
  return (
    "paths" in compilerOptions &&
    (containsPackageSpecifier(compilerOptions.paths, target.name) ||
      containsProjectPath(compilerOptions.paths, path, target.data.root))
  )
}

const hasSourcePathReference = (
  path: string,
  content: string,
  targetRoot: string,
): boolean => {
  const specifierPattern =
    /\b(?:from\s*|import\s*(?:\(\s*)?|require\(\s*)["'`]([^"'`]+)["'`]/g
  for (const match of content.matchAll(specifierPattern)) {
    const specifier = match[1]
    if (
      specifier &&
      !specifier.includes("${") &&
      referencesProjectRoot(path, specifier, targetRoot)
    ) {
      return true
    }
  }
  return false
}

const hasNonLiteralModuleLoad = (path: string, content: string): boolean => {
  const sourceFile = ts.createSourceFile(
    path,
    content,
    ts.ScriptTarget.Latest,
    false,
    path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      const specifier = node.arguments[0]
      if (
        !specifier ||
        (!ts.isStringLiteral(specifier) &&
          !ts.isNoSubstitutionTemplateLiteral(specifier))
      ) {
        found = true
        return
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

const hasStylesheetReference = (
  path: string,
  content: string,
  target: BoundaryNode,
): boolean => {
  const quotedReferences = content.matchAll(
    /@(?:source|import)\s+(?:url\(\s*)?["']([^"']+)["']/g,
  )
  const unquotedUrlReferences = content.matchAll(
    /@(?:source|import)\s+url\(\s*([^"'()\s][^)]*?)\s*\)/g,
  )
  for (const match of [...quotedReferences, ...unquotedUrlReferences]) {
    const source = match[1]?.trim()
    if (
      source &&
      (containsPackageSpecifier(source, target.name) ||
        referencesProjectRoot(path, source, target.data.root))
    ) {
      return true
    }
  }
  return false
}

const isSourceCodeFile = (path: string): boolean => /\.[cm]?[jt]sx?$/.test(path)

export const validateDashboardDependencyFiles = ({
  graph,
  files,
}: {
  graph: ProjectGraph
  files: ReadonlyArray<ReferenceFile>
}): string[] => {
  const forbiddenTargets = Object.values(graph.nodes).filter(
    isConcreteDashboardDependency,
  )

  return files.flatMap((file) => {
    if (
      !file.path.startsWith("apps/frontend/") ||
      !isNonGraphDependencyFile(file.path)
    ) {
      return []
    }

    const content = withoutComments(file.content)
    if (
      isSourceCodeFile(file.path) &&
      hasNonLiteralModuleLoad(file.path, file.content)
    ) {
      return [
        `@pf/frontend has a non-literal module load in ${file.path}, which cannot be checked against the generic Dashboard boundary. Use a bundle-visible literal import generated from the organisation artifact.`,
      ]
    }
    return forbiddenTargets.flatMap((target) => {
      const references = [
        ...(hasPackageReference(content, target.name) ? [target.name] : []),
        ...(hasConfigurationReference(file.path, file.content, target)
          ? [`${target.name} configuration`]
          : []),
        ...(hasSourcePathReference(file.path, content, target.data.root) ||
        hasStylesheetReference(file.path, content, target)
          ? [target.data.root]
          : []),
      ]

      return references.length > 0
        ? [
            `@pf/frontend -> ${target.name} (forbidden reference in ${file.path}: ${references.join(", ")}) violates the generic Dashboard boundary. Load concrete plugins from the organisation artifact.`,
          ]
        : []
    })
  })
}
