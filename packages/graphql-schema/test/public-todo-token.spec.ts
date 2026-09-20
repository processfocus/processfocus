import { buildPublicTodoUrl } from "../src/public-todo-token"
import { describe, expect, it } from "bun:test"

describe("buildPublicTodoUrl", () => {
  it("builds a public form URL from the frontend origin and token", () => {
    expect(buildPublicTodoUrl("https://app.example.com/", "abc.def.ghi")).toBe(
      "https://app.example.com/public/form/abc.def.ghi",
    )
  })

  it("encodes the capability token in the path", () => {
    expect(buildPublicTodoUrl("https://app.example.com", "a+b/c")).toBe(
      "https://app.example.com/public/form/a%2Bb%2Fc",
    )
  })
})
