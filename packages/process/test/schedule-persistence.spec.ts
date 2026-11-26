import { DateTime, Effect, Result, Schema } from "effect"
import {
  Form,
  Organisation,
  Process,
  Role,
  Schedule,
  buildFlowContext,
  makeScheduleEvaluator,
} from "../src"
import { describe, expect, it } from "bun:test"

const makeProcess = () => {
  const org = new Organisation({ name: "Schedule persistence" })
  const role = new Role(org, "Employee")
  const process = new Process(org, "dated", {
    name: "Dated",
    purpose: "Preserve authored dates after persistence",
  })
  const start = new Form(process, "start", {
    role,
    form: () => ({ startDate: Schema.DateTimeUtcFromString }),
  })
  const next = new Form(process, "next", { role, form: () => ({}) })
  process.start(start).end(next, {
    schedule: {
      text: "30 days after start",
      fn: (state) => DateTime.add(state.startDate, { days: 30 }),
    },
  })
  return { org, start, next }
}

describe("Schedules after JSON persistence", () => {
  it("rehydrates authored dates without changing persisted business data", async () => {
    const { org, start, next } = makeProcess()
    const state = { startDate: "2099-01-22T00:00:00.000Z" }
    const result = await Effect.runPromise(
      makeScheduleEvaluator(org).evaluate(
        start.node.path,
        next.node.path,
        state,
        buildFlowContext("execution", DateTime.makeUnsafe("2026-09-14"), []),
      ),
    )
    expect(Schedule.isScheduleMarker(result)).toBe(false)
    if (!Schedule.isScheduleMarker(result))
      expect(DateTime.formatIso(result)).toBe("2099-02-21T00:00:00.000Z")
    expect(state.startDate).toBe("2099-01-22T00:00:00.000Z")
  })
  it("rejects an invalid persisted date instead of releasing scheduled work", async () => {
    const { org, start, next } = makeProcess()
    const result = await Effect.runPromise(
      Effect.result(
        makeScheduleEvaluator(org).evaluate(
          start.node.path,
          next.node.path,
          { startDate: "invalid" },
          buildFlowContext("execution", DateTime.makeUnsafe("2026-09-14"), []),
        ),
      ),
    )
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result))
      expect(result.failure._tag).toBe("ScheduleEvaluationError")
  })
})
