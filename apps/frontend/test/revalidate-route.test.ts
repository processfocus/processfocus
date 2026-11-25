import { NextRequest } from "next/server"
import { POST } from "../app/api/revalidate/route"
import { afterEach, beforeEach, expect, test } from "bun:test"

const originalSecret = process.env["REVALIDATE_SECRET"]
const originalFunction = process.env["AWS_LAMBDA_FUNCTION_NAME"]

beforeEach(() => {
  process.env["REVALIDATE_SECRET"] = "test-revalidation-secret"
  process.env["AWS_LAMBDA_FUNCTION_NAME"] = "test-frontend"
})

afterEach(() => {
  for (const [key, value] of [
    ["REVALIDATE_SECRET", originalSecret],
    ["AWS_LAMBDA_FUNCTION_NAME", originalFunction],
  ] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function request(selection: object, secret = "test-revalidation-secret") {
  return new NextRequest("https://org.example.test/api/revalidate", {
    method: "POST",
    body: JSON.stringify({ ...selection, secret }),
  })
}

test.each([
  { tag: "cedar-policies" },
  { path: "/login" },
  { tag: "login-page", path: "/login" },
])("hosted revalidation explicitly rejects %j", async (selection) => {
  const response = await POST(request(selection))
  expect(response.status).toBe(501)
  expect(await response.json()).toMatchObject({ revalidated: false })
})

test("hosted rejection preserves secret authentication", async () => {
  expect((await POST(request({ tag: "cedar-policies" }, "wrong"))).status).toBe(
    401,
  )
  delete process.env["REVALIDATE_SECRET"]
  expect((await POST(request({ tag: "cedar-policies" }))).status).toBe(500)
})
