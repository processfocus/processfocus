import { createHash } from "node:crypto"
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs"
import { dirname, relative, resolve } from "node:path"
import { Schema } from "effect"
import ts from "typescript"

// Preserve source directives (especially use client/use server) until the
// consumer's Next compiler processes them. Only local import paths change.
export async function packageDashboardSource({
  workspace,
  dist,
}: {
  readonly workspace: string
  readonly dist: string
}): Promise<void> {
  const sourceRoot = resolve(dist, "dashboard-source")
  const frontend = resolve(workspace, "apps/frontend")
  const dependencies: Record<string, string> = {}
  const visited = new Set<string>()
  const outputPath = (path: string): string =>
    resolve(
      sourceRoot,
      relative(workspace, path).replace(/^packages\//, "modules/"),
    )
  const write = (path: string, content: string): void => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  const PackageManifest = Schema.Struct({
    version: Schema.String,
    dependencies: Schema.optional(
      Schema.Record({ key: Schema.String, value: Schema.String }),
    ),
    devDependencies: Schema.optional(
      Schema.Record({ key: Schema.String, value: Schema.String }),
    ),
    peerDependencies: Schema.optional(
      Schema.Record({ key: Schema.String, value: Schema.String }),
    ),
  })
  const manifestAt = (path: string): typeof PackageManifest.Type =>
    Schema.decodeUnknownSync(PackageManifest)(
      JSON.parse(readFileSync(path, "utf8")),
    )
  const runtimeManifest = manifestAt(
    resolve(workspace, "runtime/local/package.json"),
  )
  const rootManifest = manifestAt(resolve(workspace, "package.json"))
  const owner = (path: string): string => {
    let directory = dirname(path)
    while (!existsSync(resolve(directory, "package.json"))) {
      if (directory === workspace) throw new Error(`No package owns ${path}`)
      directory = dirname(directory)
    }
    return directory
  }
  const addDependency = (specifier: string, path: string): void => {
    if (
      specifier.startsWith("node:") ||
      ["server-only", "client-only"].includes(specifier)
    )
      return
    const name = specifier.startsWith("@")
      ? specifier.split("/").slice(0, 2).join("/")
      : specifier.split("/")[0]
    if (!name) return
    const manifest = manifestAt(resolve(owner(path), "package.json"))
    const types = `@types/${name.replace("@", "").replace("/", "__")}`
    const typeVersion =
      manifest.devDependencies?.[types] ?? manifest.dependencies?.[types]
    if (typeVersion) dependencies[types] ??= typeVersion
    const version =
      manifest["dependencies"]?.[name] ??
      manifest["devDependencies"]?.[name] ??
      manifest["peerDependencies"]?.[name] ??
      rootManifest["dependencies"]?.[name] ??
      rootManifest["devDependencies"]?.[name]
    if (!version) {
      if (Bun.resolveSync(specifier, dirname(path)) === specifier) return
      throw new Error(`Undeclared Dashboard dependency ${specifier} in ${path}`)
    }
    if (
      version.startsWith("workspace:") &&
      name !== "processfocus" &&
      !name.startsWith("@processfocus/")
    )
      throw new Error(`Unresolved workspace dependency ${specifier}`)
    dependencies[name] ??= version.startsWith("workspace:")
      ? runtimeManifest.version
      : version
  }
  const visit = (input: string): void => {
    const path = realpathSync(input)
    if (visited.has(path)) return
    visited.add(path)
    const local = relative(workspace, path)
    if (!local.startsWith("apps/frontend/") && !local.startsWith("packages/"))
      throw new Error(
        `Dashboard source escapes public implementation: ${local}`,
      )
    let content = readFileSync(path, "utf8")
    if (/\.[cm]?tsx?$/.test(path)) {
      const parsed = ts.createSourceFile(
        path,
        content,
        ts.ScriptTarget.Latest,
        true,
      )
      const replacements: { start: number; end: number; value: string }[] = []
      const scan = (node: ts.Node): void => {
        if (ts.isStringLiteral(node)) {
          const specifier = node.text
          const isImport =
            (ts.isImportDeclaration(node.parent) ||
              ts.isExportDeclaration(node.parent)) &&
            node.parent.moduleSpecifier === node
          const isCall =
            ts.isCallExpression(node.parent) &&
            (node.parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
              node.parent.expression.getText(parsed) ===
                "import.meta.resolve" ||
              node.parent.expression.getText(parsed) === "require")
          if (isImport || isCall) {
            if (
              specifier.startsWith("@pf/") ||
              specifier.startsWith(".") ||
              specifier.startsWith("@/")
            ) {
              const resolved = specifier.startsWith("@/")
                ? Bun.resolveSync(
                    resolve(frontend, specifier.slice(2)),
                    dirname(path),
                  )
                : Bun.resolveSync(specifier, dirname(path))
              visit(resolved)
              let target = relative(
                dirname(outputPath(path)),
                outputPath(realpathSync(resolved)),
              )
              if (!target.startsWith(".")) target = `./${target}`
              if (!specifier.startsWith("@/"))
                replacements.push({
                  start: node.getStart(parsed) + 1,
                  end: node.getEnd() - 1,
                  value: target,
                })
            } else addDependency(specifier, path)
          }
        }
        ts.forEachChild(node, scan)
      }
      scan(parsed)
      for (const replacement of replacements.sort((a, b) => b.start - a.start))
        content =
          content.slice(0, replacement.start) +
          replacement.value +
          content.slice(replacement.end)
    }
    content = content
      .replaceAll("@pf/", "processfocus:internal-tag/")
      .replaceAll("../../../packages/", "../../../modules/")
    write(outputPath(path), content)
  }
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (
        [
          "node_modules",
          ".next",
          ".open-next",
          "test",
          "scripts",
          "out-tsc",
          "dist",
          "_pf",
        ].includes(entry.name)
      )
        continue
      const path = resolve(directory, entry.name)
      if (
        directory === frontend &&
        ![
          "app",
          "components",
          "hooks",
          "lib",
          "public",
          "next.config.ts",
          "proxy.ts",
          "instrumentation.ts",
          "instrumentation-client.ts",
          "next-env.d.ts",
          "index.d.ts",
        ].includes(entry.name)
      )
        continue
      if (entry.isDirectory()) {
        if (path === resolve(frontend, "lib/generated")) {
          walk(resolve(path, "gql"))
        } else walk(path)
      } else if (
        !/\.(spec|test)\./.test(entry.name) &&
        /\.(tsx?|css|json|svg|png|ico|woff2?)$/.test(entry.name) &&
        !/^(project|tsconfig|package|components)\./.test(entry.name) &&
        !entry.name.endsWith(".tsbuildinfo")
      ) {
        if (/\.(png|ico|woff2?)$/.test(entry.name)) {
          mkdirSync(dirname(outputPath(path)), { recursive: true })
          cpSync(path, outputPath(path))
        } else visit(path)
      }
    }
  }
  walk(frontend)
  cpSync(
    resolve(frontend, "public"),
    resolve(sourceRoot, "apps/frontend/public"),
    {
      recursive: true,
      filter: (path) => !path.startsWith(resolve(frontend, "public/_pf")),
    },
  )
  // Config-loaded build tools aren't necessarily expressed as imports.
  const appManifest = manifestAt(resolve(frontend, "package.json"))
  for (const name of [
    "next",
    "react",
    "react-dom",
    "typescript",
    "@tailwindcss/postcss",
    "tailwindcss",
    "tw-animate-css",
    "babel-plugin-react-compiler",
  ]) {
    const version =
      appManifest["dependencies"]?.[name] ??
      appManifest["devDependencies"]?.[name]
    if (!version) throw new Error(`Missing Dashboard tool ${name}`)
    dependencies[name] = version
  }
  for (const name of ["@types/node", "@types/react", "@types/react-dom"]) {
    const version =
      appManifest["dependencies"]?.[name] ??
      rootManifest["devDependencies"]?.[name]
    if (version) dependencies[name] = version
  }
  for (const [name, version] of Object.entries(dependencies)) {
    if (runtimeManifest.dependencies?.[name] !== version)
      throw new Error(
        `Declare Dashboard dependency ${name}@${version} in runtime-local/package.json`,
      )
  }
  const manifest = {
    private: true,
    type: "module",
    version: runtimeManifest.version,
    // Filesystem traversal order varies between clean clones and must not
    // affect the packaged bytes.
    dependencies: Object.fromEntries(
      Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b, "en")),
    ),
  }
  write(
    resolve(sourceRoot, "apps/frontend/package.json"),
    JSON.stringify(manifest, null, 2),
  )
  write(
    resolve(sourceRoot, "apps/frontend/tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          lib: ["dom", "dom.iterable", "esnext"],
          module: "preserve",
          moduleResolution: "bundler",
          jsx: "preserve",
          strict: true,
          skipLibCheck: true,
          esModuleInterop: true,
          resolveJsonModule: true,
          allowJs: true,
          noEmit: true,
          allowImportingTsExtensions: true,
          plugins: [{ name: "next" }],
          paths: { "@/*": ["./*"] },
        },
        include: ["**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
      },
      null,
      2,
    ),
  )
  cpSync(
    resolve(frontend, "postcss.config.mjs"),
    resolve(sourceRoot, "apps/frontend/postcss.config.mjs"),
  )
  const result = await Bun.build({
    entrypoints: [
      resolve(frontend, "scripts/generate-organisation-plugin-composition.ts"),
    ],
    outdir: dist,
    naming: "prepare-dashboard.mjs",
    target: "bun",
    minify: true,
  })
  if (!result.success) throw new Error(result.logs.join("\n"))
  const hash = createHash("sha256")
  const hashTree = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) hashTree(path)
      else hash.update(relative(sourceRoot, path)).update(readFileSync(path))
    }
  }
  hashTree(sourceRoot)
  hash.update(readFileSync(resolve(dist, "prepare-dashboard.mjs")))
  hash.update(readFileSync(resolve(dist, "main.mjs")))
  write(
    resolve(dist, "dashboard-source.json"),
    JSON.stringify(
      {
        format: 1,
        sha256: hash.digest("hex"),
        dependencies: manifest.dependencies,
      },
      null,
      2,
    ),
  )
}
