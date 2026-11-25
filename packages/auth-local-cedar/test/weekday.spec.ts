import { expect, it } from "bun:test"

it("uses the same local date for weekday and requestTime across a UTC date boundary", async () => {
  // TZ must be configured before the authorization module is loaded.
  const child = Bun.spawn(
    [
      process.execPath,
      new URL("./fixtures/weekday.ts", import.meta.url).pathname,
    ],
    {
      env: { ...process.env, TZ: "Pacific/Auckland" },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ exitCode, stdout, stderr }).toEqual({
    exitCode: 0,
    stdout: "",
    stderr: "",
  })
})
