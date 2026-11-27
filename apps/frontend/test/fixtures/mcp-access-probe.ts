import { Schema } from "effect"
import { NextRequest } from "next/server"
import { expect, mock, test } from "bun:test"

// Next enforces this boundary in a build; this probe runs the route in a
// standalone process without a Next bundler.
mock.module("server-only", () => ({}))

test("read the MCP grant in a fresh Dashboard process", async () => {
  const { origin, accessToken, status } = Schema.decodeUnknownSync(
    Schema.Struct({
      origin: Schema.String,
      accessToken: Schema.String,
      status: Schema.Number,
    }),
  )(await Bun.stdin.json())
  const { POST } = await import("../../app/mcp/[[...endpoint]]/route")
  const resource = new URL("/mcp", origin)
  const response = await POST(
    new NextRequest(resource, {
      method: "POST",
      headers: {
        host: resource.host,
        authorization: `Bearer ${accessToken}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/list" }),
    }),
    { params: Promise.resolve({}) },
  )
  expect(response.status).toBe(status)
})
