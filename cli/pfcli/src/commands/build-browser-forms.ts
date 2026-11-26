import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import {
  type BrowserPluginArtifactManifest,
  type Organisation,
  isForm,
  normalizePath,
} from "@pf/process"

/** Browser modules share the Dashboard's Effect and annotation runtime. */
export const buildBrowserForms = (options: {
  readonly org: Organisation
  readonly orgPath: string
  readonly outputDir: string
}): NonNullable<BrowserPluginArtifactManifest["forms"]> => {
  const directory = join(options.outputDir, "browser-forms")
  mkdirSync(directory, { recursive: true })
  const bindings = options.org.node
    .findAll()
    .filter(isForm)
    .flatMap((form) =>
      form.browser
        ? [{ path: normalizePath(form.node.path), binding: form.browser }]
        : [],
    )
  for (const list of options.org.lists()) {
    if (list.browser)
      bindings.push({
        path: `${normalizePath(list.node.path)}/edit`,
        binding: list.browser,
      })
    if (list.createBrowser)
      bindings.push({
        path: `${normalizePath(list.node.path)}/create`,
        binding: list.createBrowser,
      })
  }
  return bindings.map(({ path, binding }) => {
    const entrypoint = Bun.resolveSync(
      resolve(options.orgPath, binding.entrypoint),
      options.orgPath,
    )
    const temporaryName = `.tmp-${randomUUID()}.js`
    const temporaryPath = join(directory, temporaryName)
    const result = Bun.spawnSync(
      [
        "bun",
        "build",
        entrypoint,
        "--outdir",
        directory,
        "--entry-naming",
        temporaryName,
        "--target",
        "browser",
        // Workspace packages expose source through the bun condition before
        // their published dist files exist, just like organisation bundles.
        "--conditions",
        "bun",
        "--format",
        "esm",
        "--production",
        "--minify",
        ...[
          "effect",
          "effect/*",
          "@pf/form-schema",
          "@pf/form-submission-schema",
        ].flatMap((name) => ["--external", name]),
      ],
      {
        cwd: options.orgPath,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 90_000,
      },
    )
    if (result.exitCode !== 0 || result.exitedDueToTimeout) {
      rmSync(temporaryPath, { force: true })
      throw new Error(
        `Browser form ${path} failed to build: ${new TextDecoder().decode(result.stderr)}`,
      )
    }
    const sha256 = createHash("sha256")
      .update(readFileSync(temporaryPath))
      .digest("hex")
    const artifactPath = `browser-forms/${sha256}.js`
    renameSync(temporaryPath, join(options.outputDir, artifactPath))
    return {
      stepPath: path,
      exportName: binding.exportName,
      hostInterfaceVersion: 1,
      path: artifactPath,
      sha256,
    }
  })
}
