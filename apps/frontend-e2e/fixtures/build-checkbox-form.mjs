import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { resolve } from "node:path"

// Compile the real renderer and the same Tailwind stylesheet as the Dashboard.
const frontendRequire = createRequire(resolve("apps/frontend/package.json"))
const tailwindPath = frontendRequire.resolve("@tailwindcss/postcss")
const postcss = createRequire(tailwindPath)("postcss")
const tailwind = frontendRequire("@tailwindcss/postcss")
const stylesheet = resolve("apps/frontend/app/global.css")
const [bundle, styles] = await Promise.all([
  Bun.build({
    entrypoints: ["packages/form/test-fixtures/checkbox-form.tsx"],
    target: "browser",
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
  }),
  postcss([tailwind()]).process(await readFile(stylesheet, "utf8"), {
    from: stylesheet,
  }),
])
if (!bundle.success)
  throw new AggregateError(bundle.logs, "Fixture build failed")
process.stdout.write(
  JSON.stringify({
    script: await bundle.outputs[0].text(),
    css: styles.css,
  }),
)
