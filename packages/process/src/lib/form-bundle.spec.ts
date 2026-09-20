import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DateTime, Effect } from "effect"
import { isForm } from "./brands"
import { buildFlowContext } from "./flow-context"
import { Form } from "./form"
import { expect, it } from "bun:test"

it("resolves a separately bundled Form through stable host brands", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pf-form-"))
  try {
    const result = await Bun.build({
      entrypoints: [
        new URL("./form-bundle.fixture.ts", import.meta.url).pathname,
      ],
      target: "bun",
      outdir: directory,
      naming: "org.js",
    })
    expect(result.success).toBe(true)
    const bundle: unknown = await import(join(directory, "org.js"))
    if (
      typeof bundle !== "object" ||
      bundle === null ||
      !("form" in bundle) ||
      !isForm(bundle.form)
    )
      throw new Error("missing branded Form")
    expect(bundle.form).not.toBeInstanceOf(Form)
    expect(bundle.form.hasForEach).toBe(true)
    const context = {
      ...buildFlowContext("actual-execution", DateTime.unsafeNow(), []),
      step: {},
    }
    expect(
      await Effect.runPromise(
        bundle.form.resolveDefaults({}, context, { name: "item" }),
      ),
    ).toMatchObject({ name: "actual-execution:item" })
    expect(bundle.form.submissionSchema()).toMatchObject({
      properties: { name: { type: "string" } },
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
