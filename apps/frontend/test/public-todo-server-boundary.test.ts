import { resolve } from "node:path"
import { describe, expect, test } from "vitest"

const serverBoundaryScript = `
  import { mock } from "bun:test"

  let requestedDocument = ""
  const request = mock(async (document) => {
    requestedDocument = String(document)
    return ({
    publicTodo: {
      todoId: "todo-1",
      status: "ACTIVE",
      formMetadata: {
        stepPath: "/enrolment/Upload documents",
        processName: "Enrolment",
        requestData: { presentation: {}, originalValues: {}, inaccessible: [] },
        defaultValues: {},
      },
    },
    })
  })

  mock.module("server-only", () => ({}))
  mock.module("@pf/auth-session", () => ({
    getFrontendJwt: () => "frontend-jwt",
  }))
  mock.module("./lib/graphql/server-client", () => ({
    createServerGraphqlClient: () => ({ request }),
  }))

  const { fetchPublicTodo } = await import("./lib/public-todo-server")
  const todo = await fetchPublicTodo("secret-capability-token")

  process.stdout.write(JSON.stringify({ requestedDocument, todo }))
`

describe("public todo server boundary", () => {
  test("loads request data without serialized form definitions", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "--eval", serverBoundaryScript],
      cwd: resolve(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(result.exitCode).toBe(0)

    const output: {
      readonly requestedDocument: string
      readonly todo: unknown
    } = JSON.parse(result.stdout.toString())
    expect(output.todo).toEqual(
      expect.objectContaining({
        formMetadata: expect.objectContaining({
          requestData: {
            presentation: {},
            originalValues: {},
            inaccessible: [],
          },
        }),
      }),
    )
    expect(output.requestedDocument).toContain("requestData")
    expect(output.requestedDocument).not.toContain("formDefinition")
    expect(output.requestedDocument).not.toContain("jsonSchema")
    expect(output.requestedDocument).not.toContain("clientRepresentation")
    expect(output.requestedDocument).not.toMatch(/^\s*rules\s*$/m)
  })
})
