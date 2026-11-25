import { expect, it } from "bun:test"

// The transaction unit suite mocks the SDK process-wide. Run the transport
// contract in a separate process so it always exercises the pinned real SDK.
it.skipIf(!Bun.which("sqld"))(
  "initializes through the real SDK and local SQL server",
  async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "test",
        "./test/session-initialization.integration.test.ts",
      ],
      {
        cwd: `${import.meta.dir}/..`,
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ code, output: code === 0 ? "" : stdout + stderr }).toEqual({
      code: 0,
      output: "",
    })
  },
  30_000,
)
