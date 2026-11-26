import { Context, Effect, Layer } from "effect"
import { notFound, redirect } from "next/navigation"
import { makePageRuntime } from "../lib/effect/page-runtime"
import { expect, test } from "bun:test"

class RequestIdentity extends Context.Service<RequestIdentity, string>()(
  "test/RequestIdentity",
) {}

test("concurrent page invocations isolate services and release their scopes", async () => {
  const released: string[] = []
  let acquired = 0
  const pages = makePageRuntime(
    "test",
    Layer.effect(
      RequestIdentity,
      Effect.acquireRelease(
        Effect.sync(() => String(++acquired)),
        (id) =>
          Effect.sync(() => {
            released.push(id)
          }),
      ),
    ),
  )
  const page = pages.build(() =>
    Effect.gen(function* () {
      const first = yield* RequestIdentity
      yield* Effect.yieldNow
      return [first, yield* RequestIdentity]
    }),
  )
  const results = await Promise.all([page(), page()])
  expect(results).toEqual([
    ["1", "1"],
    ["2", "2"],
  ])
  expect(released.sort()).toEqual(["1", "2"])
})

for (const [name, navigate, digest] of [
  ["not-found", () => notFound(), "NEXT_HTTP_ERROR_FALLBACK;404"],
  ["redirect", () => redirect("/login"), "NEXT_REDIRECT;replace;/login;307;"],
] as const) {
  test(`page ${name} retains framework control flow and releases its scope`, async () => {
    let released = false
    const pages = makePageRuntime(
      "test",
      Layer.effect(
        RequestIdentity,
        Effect.acquireRelease(Effect.succeed("request"), () =>
          Effect.sync(() => {
            released = true
          }),
        ),
      ),
    )
    const page = pages.build(() => Effect.sync(navigate))
    await expect(page()).rejects.toMatchObject({ digest })
    expect(released).toBe(true)
  })
}
