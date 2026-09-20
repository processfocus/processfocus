import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "bun:test"

describe("exclusive local runtime ports", () => {
  it.each(["normal", "--watch", "--hot"])(
    "isolates organisations and discovers a fallback port under %s",
    async (mode) => {
      const directory = await mkdtemp(join(tmpdir(), "pf-server-ports-"))
      // Reproduce an existing auth process that permits SO_REUSEPORT.
      const occupied = Bun.serve({
        port: 0,
        development: false,
        reusePort: true,
        fetch: () => new Response("first organisation"),
      })
      const child = Bun.spawn(
        [
          process.execPath,
          ...(mode === "normal" ? [] : [mode]),
          fileURLToPath(
            import.meta.resolve("./test-fixtures/server-port-child.ts"),
          ),
          String(occupied.port),
          join(directory, ".auth-port.json"),
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
          env: { PATH: process.env["PATH"] },
          timeout: 10_000,
        },
      )
      try {
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
        expect(stdout).toContain(`Port ${occupied.port} was in use`)
      } finally {
        child.kill()
        await child.exited
        await occupied.stop(true)
        await rm(directory, { recursive: true, force: true })
      }
    },
    15_000,
  )
})
