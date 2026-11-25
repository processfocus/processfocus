import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Schema } from "effect"
import { expect, it } from "bun:test"

it.each(["success", "lost-response", "unknown-region"])(
  "project create CLI handles %s without duplicate creation",
  async (scenario) => {
    let mutations = 0
    const server = Bun.serve({
      hostname: "127.0.0.2",
      port: 0,
      async fetch(request) {
        expect(request.headers.get("authorization")).toBe("Bearer test-token")
        const body = Schema.decodeUnknownSync(
          Schema.Struct({
            query: Schema.String,
            variables: Schema.Record(Schema.String, Schema.Unknown),
          }),
        )(await request.json())
        if (body.query.includes("hostingContract")) {
          return Response.json({ errors: [{ message: "Not supported" }] })
        }
        if (body.query.includes("consoleProjectCreationOptions")) {
          return Response.json({
            data: {
              consoleProjectCreationOptions: {
                regions: [{ value: "region-1", label: "Test region" }],
              },
            },
          })
        }
        if (body.query.includes("mutation CreateProject")) {
          mutations++
          expect(body.variables["input"]).toEqual({
            projectName: "Test project",
            regionId: "region-1",
          })
          if (scenario === "lost-response")
            return new Response("unavailable", { status: 502 })
          return Response.json({
            data: {
              startOperationsProjectSignup: { executionId: "execution-1" },
            },
          })
        }
        expect(body.variables["executionId"]).toBe("execution-1")
        return Response.json({
          data: {
            consoleProjectCreation: {
              status: "SUCCEEDED",
              projectId: "project-1",
              projectNumber: "1234-5678-9012",
            },
          },
        })
      },
    })
    const directory = await mkdtemp(join(tmpdir(), "pfcli-create-"))
    try {
      const credentials = join(directory, "credentials.json")
      await writeFile(
        credentials,
        JSON.stringify({
          version: 1,
          baseUrl: `http://127.0.0.2:${server.port}`,
          accessToken: "test-token",
          expiresAt: "2099-01-01T00:00:00Z",
          loginAt: "2026-01-01T00:00:00Z",
        }),
      )
      const process = Bun.spawn(
        [
          "bun",
          join(import.meta.dir, "../src/main.ts"),
          "project",
          "create",
          "--name",
          "Test project",
          "--region",
          scenario === "unknown-region" ? "missing" : "region-1",
        ],
        {
          env: {
            ...Bun.env,
            PFCLI_CREDENTIALS_PATH: credentials,
            PFCLI_AUTH_MODE: "",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [stdout, stderr, exit] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ])
      expect(exit).toBe(scenario === "success" ? 0 : 1)
      expect(mutations).toBe(scenario === "unknown-region" ? 0 : 1)
      if (scenario === "success")
        expect(stdout).toContain('"projectNumber":"1234-5678-9012"')
      if (scenario === "lost-response")
        expect(stderr).toContain("outcome is uncertain")
      if (scenario === "unknown-region")
        expect(stderr).toContain("Unknown region")
    } finally {
      server.stop(true)
      await rm(directory, { recursive: true, force: true })
    }
  },
)
