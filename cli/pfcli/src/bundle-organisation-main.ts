const [entrypoint, outdir] = process.argv.slice(2)
if (!entrypoint || !outdir)
  throw new Error("Expected organisation entrypoint and output directory")

const result = await Bun.build({
  entrypoints: [entrypoint],
  outdir,
  naming: "org.js",
  minify: true,
  target: "node",
  conditions: ["bun"],
  // Native/target-specific implementations must remain runtime-resolved.
  // Serverless stays bundled: the AWS runtime does not install that driver.
  external: [
    "@cedar-policy/cedar-wasm",
    "@tursodatabase/database",
    "@tursodatabase/sync",
  ],
})
if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
