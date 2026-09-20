import { Cause, DateTime, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { jobHandler, makeJobDispatcher } from "./job.js"
import type { PayloadParseError } from "./queue.js"
import { type RawJob, validateQueueName } from "./queue.js"
import { Runtime } from "./runtime.js"

const rawJob = (payload: unknown): RawJob => ({
  jobId: "job-1",
  receipt: "receipt-1",
  queue: "example",
  payload,
  attempts: 1,
  maxAttempts: 5,
  availableAt: DateTime.unsafeMake(0),
  lockedUntil: DateTime.unsafeMake(1_000),
})

describe("runtime", () => {
  it("validates portable queue names", async () => {
    await expect(
      Effect.runPromise(validateQueueName("valid.queue-1")),
    ).resolves.toBe("valid.queue-1")
    const invalid = await Effect.runPromise(
      validateQueueName("not valid").pipe(Effect.either),
    )
    expect(invalid).toMatchObject({
      _tag: "Left",
      left: { _tag: "InvalidQueueNameError" },
    })
  })

  it("parses provider-neutral artifacts", async () => {
    const envelope = await Effect.runPromise(
      Runtime.loadArtifact(
        Effect.succeed({
          format: "processfocus/runtime-artifact",
          version: 1,
          organisation: { name: "Example" },
        }),
      ),
    )
    expect(envelope.extensions).toEqual({})
  })

  it("rejects artifacts without an organisation object", async () => {
    const result = await Effect.runPromise(
      Runtime.loadArtifact(
        Effect.succeed({
          format: "processfocus/runtime-artifact",
          version: 1,
          organisation: null,
        }),
      ).pipe(Effect.either),
    )

    expect(result).toMatchObject({
      _tag: "Left",
      left: { _tag: "ArtifactParseError" },
    })
  })

  it("loads and hydrates organisations through runtime-owned operations", async () => {
    const events: string[] = []
    const organisation = await Effect.runPromise(
      Runtime.loadOrganisation(
        {
          load: (name: string) =>
            Effect.sync(() => {
              events.push("load")
              return { name }
            }),
        },
        "Example",
      ),
    )

    await Effect.runPromise(
      Runtime.hydrateOrganisation(
        {
          hydrate: () => Effect.sync(() => events.push("hydrate")),
        },
        {
          transaction: (operation) =>
            Effect.sync(() => events.push("transaction")).pipe(
              Effect.zipRight(operation),
            ),
        },
        organisation,
      ),
    )

    expect(events).toEqual(["load", "transaction", "hydrate"])
  })

  it("dispatches parsed jobs through the shared engine", async () => {
    const handled: string[] = []
    const handlers = {
      example: jobHandler({
        schema: Schema.Struct({ value: Schema.String }),
        handle: (job) => Effect.sync(() => handled.push(job.payload.value)),
      }),
    }
    const dispatcher = makeJobDispatcher<never, never, typeof handlers>(
      handlers,
    )

    const result = await Effect.runPromise(
      Runtime.job(dispatcher, rawJob({ value: "ok" })),
    )
    expect(result.kind).toBe("acknowledge")
    expect(handled).toEqual(["ok"])
  })

  it("classifies malformed payloads as terminal", async () => {
    const handlers = {
      example: jobHandler({
        schema: Schema.Struct({ value: Schema.String }),
        handle: () => Effect.void,
      }),
    }
    const dispatcher = makeJobDispatcher<never, never, typeof handlers>(
      handlers,
    )
    const result = await Effect.runPromise(
      Runtime.job(dispatcher, rawJob({ value: 1 })),
    )
    expect(result.kind).toBe("terminal")
  })

  it("classifies parse errors from a separate package copy by tag", async () => {
    const foreignError = {
      _tag: "PayloadParseError",
      queue: "example",
      jobId: "job-1",
      error: {},
    } as unknown as PayloadParseError
    const handlers = {
      example: { execute: () => Effect.fail(foreignError) },
    }
    const dispatcher = makeJobDispatcher<never, never, typeof handlers>(
      handlers,
    )

    const result = await Effect.runPromise(
      Runtime.job(dispatcher, rawJob({ value: "ignored" })),
    )

    expect(result.kind).toBe("terminal")
  })

  it("returns handler interruption for adapter retry policy", async () => {
    const handlers = {
      example: jobHandler({
        schema: Schema.Struct({ value: Schema.String }),
        handle: () => Effect.interrupt,
      }),
    }
    const dispatcher = makeJobDispatcher<never, never, typeof handlers>(
      handlers,
    )

    const result = await Effect.runPromise(
      Runtime.job(dispatcher, rawJob({ value: "stop" })),
    )

    expect(result.kind).toBe("retry")
    if (result.kind !== "acknowledge") {
      expect(Cause.isInterruptedOnly(result.cause)).toBe(true)
    }
  })
})
