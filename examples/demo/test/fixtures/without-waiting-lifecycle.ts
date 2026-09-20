import { appendFile, readFile } from "node:fs/promises"
import { Data, DateTime, Effect, Option, Schema } from "effect"
import {
  Form,
  NodeStep,
  type Organisation,
  Process,
  type Role,
} from "@pf/process"

class LifecycleFailure extends Data.TaggedError("LifecycleFailure")<{
  readonly message: string
  readonly retryable: boolean
}> {}

// Copied into a disposable demo only. The file-backed action is a real side
// effect: its attempt journal survives worker restarts and exposes replay.
export const addLifecycleFixtures = (org: Organisation, role: Role): void => {
  for (const handled of [false, true]) {
    const process = new Process(org, handled ? "handled" : "lifecycle", {
      name: handled ? "Handled lifecycle" : "Lifecycle recovery",
      purpose: "Disposable runtime lifecycle acceptance",
    })
    const submit = new Form(process, "Submit", {
      role,
      form: () => ({ control: Schema.String }),
    })
    const start = process.start(submit)
    const action = new NodeStep(start, "Action", {
      input: (state) => Effect.succeed({ control: state.control }),
      output: { action_count: Schema.Number },
      execute: ({ control }) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now
          const outcome = yield* Effect.tryPromise(() =>
            readFile(control, "utf8"),
          )
          yield* Effect.tryPromise(() =>
            appendFile(`${control}.attempts`, `${DateTime.formatIso(now)}\n`),
          )
          if (outcome !== "success")
            return yield* new LifecycleFailure({
              message: "Configured lifecycle action failure",
              retryable: outcome === "retry",
            })
          const attempts = yield* Effect.tryPromise(() =>
            readFile(`${control}.attempts`, "utf8"),
          )
          return { action_count: attempts.trim().split("\n").length }
        }),
    })
    const future = {
      fn: () => DateTime.unsafeMake("2099-01-01T00:00:00Z"),
      text: "Future business date",
    }
    const actionFlow = start.next(action, { schedule: future })
    const gate = new Form(actionFlow, "Gate", { role, form: () => ({}) })
    const gateFlow = actionFlow.next(gate, { schedule: future })
    const items = new Form(gateFlow, "Item", {
      role,
      forEach: { items: () => Effect.succeed([{ id: "one" }, { id: "two" }]) },
      form: () => ({}),
    })
    const barrier = gateFlow.next(items, { schedule: future })
    const after = new Form(barrier, "After", { role, form: () => ({}) })
    barrier.end(after, { schedule: future })
    const witness = new Form(start, "Witness", { role, form: () => ({}) })
    start.end(witness)
    const never = new Form(start, "Never", { role, form: () => ({}) })
    start.end(never, {
      schedule: future,
      condition: { fn: () => false, text: "False stays false" },
    })
    const clock = new Form(start, "Clock", { role, form: () => ({}) })
    start.end(clock, {
      condition: {
        fn: () =>
          DateTime.greaterThan(
            DateTime.unsafeNow(),
            DateTime.unsafeMake("2099-01-01T00:00:00Z"),
          ),
        text: "The real clock is in 2099",
      },
    })
    const alternate = new Form(start, "Alternate", { role, form: () => ({}) })
    start.else().end(alternate)
    if (handled) {
      const recovered = new Form(process, "Recovered", {
        role,
        form: () => ({}),
      })
      action.onError(recovered, { taggedErrors: ["LifecycleFailure"] }).end()
    }
  }
  const invalid = new Process(org, "invalid-schedule", {
    name: "Invalid schedule",
    purpose: "Disposable schedule error acceptance",
  })
  const submit = new Form(invalid, "Submit", {
    role,
    form: () => ({ date: Schema.String }),
  })
  const start = invalid.start(submit)
  const target = new Form(start, "Target", { role, form: () => ({}) })
  start.end(target, {
    schedule: {
      fn: (state) =>
        Option.getOrThrowWith(
          DateTime.make(state.date),
          () => new Error(`Invalid authored schedule: ${state.date}`),
        ),
      text: "Parse the authored date",
    },
  })
}
