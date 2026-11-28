import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, mock, test } from "bun:test"

mock.module("next/server", () => ({ connection: async () => {} }))

test("streams committed GraphQL revisions to a Dashboard opened before its first import", async () => {
  const { GET } = await import("../app/api/dev/import-events/route")
  const org = mkdtempSync(join(tmpdir(), "dashboard-ready-"))
  const previous = { ...process.env }
  const env = {
    NODE_ENV: "development",
    PF_ORG: org,
    PF_LOCAL_GRAPHQL_IMPORT: "1",
  }
  Object.assign(process.env, env)
  const directory = join(org, ".processfocus/local-graphql")
  const publish = (revision: string) => {
    writeFileSync(
      join(directory, "next"),
      JSON.stringify({ revision, processPaths: ["/key-request"] }),
    )
    renameSync(join(directory, "next"), join(directory, "ready.json"))
  }
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const response = await GET(
      new Request("http://localhost/api/dev/import-events"),
    )
    reader = response.body!.getReader()
    const next = async () =>
      new TextDecoder().decode((await reader!.read()).value)
    expect(await next()).toContain(": connected")
    publish("first")
    expect(await next()).toBe('id: first\ndata: {"processPaths":[]}\n\n')
    publish("second")
    expect(await next()).toBe(
      'id: second\ndata: {"processPaths":["/key-request"]}\n\n',
    )
  } finally {
    await reader?.cancel()
    for (const key of Object.keys(env)) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
    rmSync(org, { recursive: true, force: true })
  }
})
