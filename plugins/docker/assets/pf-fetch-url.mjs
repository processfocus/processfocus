import { copyFile, mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"

const [url, destination] = process.argv.slice(2)

if (!url || !destination) {
  console.error("Usage: node pf-fetch-url.mjs <url> <destination>")
  process.exit(1)
}

await mkdir(dirname(destination), { recursive: true })

if (url.startsWith("file://")) {
  await copyFile(fileURLToPath(url), destination)
  process.exit(0)
}

const response = await fetch(url)
if (!response.ok) {
  console.error(
    `Failed to fetch ${url}: ${response.status} ${response.statusText}`,
  )
  process.exit(1)
}

const buffer = Buffer.from(await response.arrayBuffer())
await writeFile(destination, buffer)
