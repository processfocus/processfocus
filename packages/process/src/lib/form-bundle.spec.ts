import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DateTime, Effect, Result, Schema } from "effect"
import { isForm } from "./brands"
import { buildFlowContext } from "./flow-context"
import { Form } from "./form"
import { expect, it } from "bun:test"

it("resolves and validates a separately bundled Form in the host runtime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pf-form-"))
  try {
    const result = await Bun.build({
      entrypoints: [
        new URL("./form-bundle.fixture.ts", import.meta.url).pathname,
      ],
      target: "bun",
      minify: true,
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
    // This fixture has no decoding services. Keep the bundle's AST (including
    // its parser methods), as the deployed host does with organisation schemas.
    const schema = Schema.make<Schema.Codec<unknown>>(
      bundle.form.submissionEffectSchema.ast,
    )
    const input = {
      name: "Chair",
      accepted: true,
      amount: "150",
      approved: true,
      startDate: "2026-10-14T00:00:00.000Z",
    }
    const decoded = await Effect.runPromise(
      Schema.decodeUnknownEffect(schema)(input),
    )
    expect(decoded).toEqual({
      ...input,
      amount: 150,
      startDate: DateTime.makeUnsafe(input.startDate),
    })
    expect(Schema.encodeSync(schema)(decoded)).toEqual(input)
    for (const invalid of [
      { ...input, amount: "not a number" },
      { ...input, approved: false },
      { ...input, startDate: "not a date" },
      { ...input, amount: undefined },
    ]) {
      expect(
        Result.isFailure(Schema.decodeUnknownResult(schema)(invalid)),
      ).toBe(true)
    }
    expect(bundle.form.hasForEach).toBe(true)
    const context = {
      ...buildFlowContext("actual-execution", DateTime.nowUnsafe(), []),
      step: {},
    }
    expect(
      await Effect.runPromise(
        bundle.form.resolveDefaults({}, context, { name: "item" }),
      ),
    ).toMatchObject({ name: "actual-execution:item" })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
