import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import {
  BROWSER_PLUGIN_ARTIFACT_MANIFEST_FILE,
  parseBrowserPluginArtifactManifest,
} from "@pf/frontend-manifest"
import { stageVerifiedBrowserPluginArtifact } from "./generate-organisation-plugin-composition"

export const generateOrganisationFormLoaders = (
  artifactRoot: string,
  outputPath: string,
): void => {
  const realArtifactRoot = realpathSync(artifactRoot)
  const manifestPath = join(artifactRoot, BROWSER_PLUGIN_ARTIFACT_MANIFEST_FILE)
  const forms = existsSync(manifestPath)
    ? (parseBrowserPluginArtifactManifest(
        JSON.parse(readFileSync(manifestPath, "utf8")),
      ).forms ?? [])
    : []
  const entries = forms.map((form) => {
    const stagedPath = stageVerifiedBrowserPluginArtifact({
      identity: form.stepPath,
      artifactPath: form.path,
      artifactPathField: "path",
      artifactRoot,
      realArtifactRoot,
      expectedSha256: form.sha256,
      outputDirectory: join(dirname(outputPath), "browser-forms"),
      stagedExtension: ".js",
    })
    const importPath = `./${relative(dirname(outputPath), stagedPath).replaceAll("\\", "/")}`
    return `  ${JSON.stringify(form.stepPath)}: async () => (await import(${JSON.stringify(importPath)}))[${JSON.stringify(form.exportName)}],`
  })
  writeFileSync(
    outputPath,
    `// Generated from verified organisation browser artifacts.\nexport const organisationFormLoaders: Readonly<Record<string, (() => Promise<unknown>) | undefined>> = {\n${entries.join("\n")}\n}\n`,
  )
}

if (import.meta.main) {
  const [artifactRoot, outputPath] = process.argv.slice(2)
  if (!artifactRoot || !outputPath)
    throw new Error(
      "usage: generate-organisation-form-loaders <artifact-root> <output-path>",
    )
  generateOrganisationFormLoaders(artifactRoot, outputPath)
}
