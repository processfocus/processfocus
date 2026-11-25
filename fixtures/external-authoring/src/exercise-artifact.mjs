import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { Option, Schema } from "effect"

/** Decode the packaged bytes with the consumer's Effect runtime, never source. */
export async function verifyPackagedCustomField(root) {
  const manifest = JSON.parse(
    readFileSync(join(root, "browser-plugins.json"), "utf8"),
  )
  const form = manifest.forms?.find((entry) =>
    entry.stepPath.endsWith("/Plugin/Submit"),
  )
  const plugin = manifest.plugins.find(
    (entry) => entry.identity === "fixture-custom-field",
  )
  if (!form || !plugin)
    throw new Error("Unknown plugin and form were not packaged")
  for (const entry of [form, plugin]) {
    if (
      createHash("sha256")
        .update(readFileSync(join(root, entry.path)))
        .digest("hex") !== entry.sha256
    )
      throw new Error("Packaged artifact integrity mismatch")
  }
  const module = await import(pathToFileURL(join(root, form.path)).href)
  if (typeof module !== "object" || module === null)
    throw new Error("Invalid form module")
  const definition = Reflect.get(module, form.exportName)
  if (!Schema.isSchema(definition))
    throw new Error("Cross-bundle schema identity failed")
  const codec = Schema.make(definition.ast)
  const decoded = Schema.decodeUnknownSync(codec)({
    summary: "  Packaged plugin  ",
  })
  if (
    JSON.stringify(decoded) !== JSON.stringify({ summary: "Packaged plugin" })
  )
    throw new Error("Packaged codec did not transform input")
  if (Option.isSome(Schema.decodeUnknownOption(codec)({ summary: "x" })))
    throw new Error("Packaged codec accepted invalid input")
  const client = await import(pathToFileURL(join(root, plugin.path)).href)
  if (
    typeof client !== "object" ||
    client === null ||
    !("plugin" in client) ||
    typeof client.plugin !== "object" ||
    client.plugin === null ||
    !("activate" in client.plugin) ||
    typeof client.plugin.activate !== "function"
  )
    throw new Error("Missing packaged plugin activation")
  let registered = false
  client.plugin.activate({
    formRenderers: {
      register(registration) {
        if (
          typeof registration !== "object" ||
          registration === null ||
          !("type" in registration) ||
          registration.type !== "fixture-custom-field" ||
          !("renderer" in registration) ||
          typeof registration.renderer !== "function"
        )
          throw new Error("Invalid installed renderer")
        registered = true
        return () => {}
      },
    },
  })
  if (!registered) throw new Error("Packaged plugin did not register")
}

if (process.argv[1]?.endsWith("exercise-artifact.mjs"))
  await verifyPackagedCustomField(resolve(process.argv[2] ?? "pfcli-dist"))
