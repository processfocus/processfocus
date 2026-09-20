import { copyFile, readFile, readdir, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"

const dist = resolve("dist")
const declarations = join(dist, "sdk/src")

for (const entry of await readdir(declarations)) {
  if (!entry.endsWith(".d.ts")) continue
  await copyFile(join(declarations, entry), join(dist, entry))
}

const packageEntries = {
  "@pf/business-calendar": "business-calendar/src/index.js",
  "@pf/form-client-representation": "form-client-representation/src/index.js",
  "@pf/form-client-representation/types":
    "form-client-representation/src/lib/types.js",
  "@pf/frontend-plugin-host": "frontend-plugin-host/src/index.js",
  "@pf/form-rule": "form-rule/src/index.js",
  "@pf/form-schema": "form-schema/src/index.js",
  "@pf/form-submission-schema": "form-submission-schema/src/index.js",
  "@pf/frontend-manifest": "frontend-manifest/src/index.js",
} as const

const rewrite = async (directory: string): Promise<void> => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      await rewrite(path)
      continue
    }
    if (/\.m?js$/.test(entry.name)) {
      const content = await readFile(path, "utf8")
      await writeFile(path, content.replaceAll("@pf/", "processfocus/"))
      continue
    }
    if (!/\.d\.ts$/.test(entry.name)) continue

    let content = await readFile(path, "utf8")
    content = content.replaceAll("../../", "./")
    for (const [specifier, target] of Object.entries(packageEntries).sort(
      ([left], [right]) => right.length - left.length,
    )) {
      let replacement = relative(dirname(path), join(dist, target))
      if (!replacement.startsWith(".")) replacement = `./${replacement}`
      content = content.replaceAll(`"${specifier}"`, `"${replacement}"`)
    }
    content = content.replaceAll(/"\.\.\/\.\.\/([^".][^"]*)"/g, '"../$1"')
    content = content.replaceAll("@pf/", "processfocus/")
    content = content.replaceAll("processfocus/process", "processfocus")
    content = content.replaceAll(
      "processfocus/business-calendar",
      "processfocus/calendar",
    )
    content = content.replaceAll(
      'import DirectedGraph from "graphology"',
      'import { MultiDirectedGraph as DirectedGraph } from "graphology"',
    )
    content = content.replaceAll(
      /"(\.{1,2}\/[^"?]+)"/g,
      (match: string, specifier: string) =>
        /\.[a-z0-9]+$/i.test(specifier) ? match : `"${specifier}.js"`,
    )
    await writeFile(path, content)
  }
}

await rewrite(dist)
