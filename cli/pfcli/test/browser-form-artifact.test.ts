import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { Schema } from "effect"
import { Form, Organisation, Process, Role } from "@pf/process"
import { buildBrowserForms } from "../src/commands/build-browser-forms"
import { expect, test } from "bun:test"

const generateOrganisationFormLoaders = (
  artifactRoot: string,
  outputPath: string,
): void => {
  const result = Bun.spawnSync(
    [
      "bun",
      resolve(
        import.meta.dirname,
        "../../../apps/frontend/scripts/generate-organisation-form-loaders.ts",
      ),
      artifactRoot,
      outputPath,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  if (result.exitCode !== 0)
    throw new Error(new TextDecoder().decode(result.stderr))
}

test("browser forms bundle source-only workspace package exports", async () => {
  const root = mkdtempSync(
    resolve(import.meta.dirname, "../../../examples/demo/.browser-form-"),
  )
  try {
    const dependency = join(root, "node_modules/source-only-field")
    mkdirSync(dependency, { recursive: true })
    writeFileSync(
      join(dependency, "package.json"),
      JSON.stringify({
        name: "source-only-field",
        type: "module",
        exports: { ".": { bun: "./field.ts", import: "./dist/field.js" } },
      }),
    )
    writeFileSync(
      join(dependency, "field.ts"),
      'import { Schema } from "effect"; export const field = Schema.String',
    )
    writeFileSync(
      join(root, "form.ts"),
      'import { Schema } from "effect"; import { field } from "source-only-field"; export const form = Schema.Struct({ value: field })',
    )
    const org = new Organisation({ name: "Source exports" })
    const role = new Role(org, "employee", { name: "Employee" })
    const process = new Process(org, "request", {
      name: "Request",
      purpose: "Request approval",
    })
    new Form(process, "submit", {
      role,
      form: Schema.Struct({ value: Schema.String }),
      browser: { entrypoint: "form.ts", exportName: "form" },
    })
    const outputDir = join(root, "dist")
    const [artifact] = buildBrowserForms({ org, orgPath: root, outputDir })
    if (!artifact) throw new Error("Missing packaged form")
    const { form } = await import(join(outputDir, artifact.path))
    expect(Schema.decodeUnknownSync(form)({ value: "request" })).toEqual({
      value: "request",
    })
    // A clean deployment build must fail when the package only declares a
    // nonexistent dist export (the #3446 failure class).
    writeFileSync(
      join(dependency, "package.json"),
      JSON.stringify({
        name: "source-only-field",
        type: "module",
        exports: "./dist/field.js",
      }),
    )
    expect(() => buildBrowserForms({ org, orgPath: root, outputDir })).toThrow(
      "source-only-field",
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// Owns the artifact transport contract: the generated host executes a packaged
// schema, and refuses changed bytes or an incompatible interface before staging.
test("browser form artifact survives packaging and validates its delivery contract", async () => {
  const root = mkdtempSync(
    resolve(import.meta.dirname, "../../../examples/demo/.browser-form-"),
  )
  const output = join(root, "dist")
  const staged = join(root, "staged")
  mkdirSync(staged)
  try {
    const org = new Organisation({ name: "Forms" })
    const role = new Role(org, "employee", { name: "Employee" })
    const process = new Process(org, "purchase", {
      name: "Purchase",
      purpose: "Request purchase",
    })
    new Form(process, "submit", {
      role,
      form: Schema.Struct({ value: Schema.String }),
      browser: {
        entrypoint: "src/purchase-request-form.ts",
        exportName: "purchaseRequestForm",
      },
    })
    const forms = buildBrowserForms({
      org,
      orgPath: resolve(import.meta.dirname, "../../../examples/demo"),
      outputDir: output,
    })
    const manifest = {
      format: "processfocus/browser-plugins",
      version: 1,
      plugins: [],
      forms,
    }
    const manifestPath = join(output, "browser-plugins.json")
    writeFileSync(manifestPath, JSON.stringify(manifest))
    const loaderPath = join(staged, "loaders.ts")
    generateOrganisationFormLoaders(output, loaderPath)
    // The emitted module's executable behavior matters, not its source layout.
    const module = await import(loaderPath)
    const loader = Object.values(module.organisationFormLoaders)[0]
    if (typeof loader !== "function")
      throw new Error("Missing executable loader")
    const definition: unknown = await loader()
    if (!Schema.isSchema(definition)) throw new Error("Invalid exported schema")
    expect(
      Schema.decodeUnknownSync(
        Schema.make<Schema.Codec<unknown>>(definition.ast),
      )({
        request: { item: "  Chair  ", value: "42" },
      }),
    ).toEqual({ request: { item: "Chair", value: 42 } })
    const form = forms[0]
    if (!form) throw new Error("Missing packaged form")
    // Reject modified bytes before a host can import the module.
    const artifact = join(output, form.path)
    writeFileSync(artifact, "export const purchaseRequestForm = null")
    expect(() => generateOrganisationFormLoaders(output, loaderPath)).toThrow(
      "integrity mismatch",
    )
    writeFileSync(
      manifestPath,
      JSON.stringify({
        ...manifest,
        forms: forms.map((entry) => ({ ...entry, hostInterfaceVersion: 999 })),
      }),
    )
    expect(() => generateOrganisationFormLoaders(output, loaderPath)).toThrow(
      "unsupported form host interface",
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
