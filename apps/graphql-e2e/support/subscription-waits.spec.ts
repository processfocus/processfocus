import { randomUUID } from "node:crypto"
import { supportCodeLibraryBuilder } from "@cucumber/cucumber"
import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test"

supportCodeLibraryBuilder.reset(process.cwd(), randomUUID)
const { TestWorld } = await import("./world")
await import("../steps/subscription.steps")
const support = supportCodeLibraryBuilder.finalize()

const originalHost = process.env["APPSYNC_EVENTS_HTTP_HOST"]

beforeEach(() => {
  process.env["APPSYNC_EVENTS_HTTP_HOST"] = "deployed-test"
  jest.useFakeTimers()
})

afterEach(() => {
  jest.useRealTimers()
  if (originalHost === undefined) delete process.env["APPSYNC_EVENTS_HTTP_HOST"]
  else process.env["APPSYNC_EVENTS_HTTP_HOST"] = originalHost
})

const createWorld = () => {
  const world = new TestWorld({
    attach: async () => {},
    log: () => {},
    link: () => {},
    parameters: {},
  })
  const subscription = (): NonNullable<
    Parameters<typeof world.userSessions.set>[1]["subscriptions"]["todo"]
  > => ({
    wsClient: null,
    appSyncClient: null,
    cleanup: null,
    events: [],
    error: null,
    eventNotifier: null,
  })
  world.userSessions.set("user", {
    accessToken: "unused",
    subscriptions: {
      todo: subscription(),
      process: subscription(),
      execution: subscription(),
    },
  })
  return world
}

const todoEvent = {
  streamTodo: {
    documents: [
      {
        stepName: "Approve expensive purchase request",
        stepPath: "/finance/purchase-request/Procurement approval",
        deleted: false,
        summary: [{ label: "What", value: "Laptop for 2500" }],
      },
    ],
  },
}

describe("deployed subscription waits", () => {
  it("accepts the procurement event after the observed CI publication lag", async () => {
    const world = createWorld()
    const state = world.userSessions.get("user")?.subscriptions.todo
    if (!state) throw new Error("Missing test subscription")
    const wait = world.waitForUserTodoWithSummary(
      "user",
      "Approve expensive purchase request",
      "What",
      "Laptop for 2500",
    )
    const outcome = wait.then(
      () => "received",
      (error: unknown) => error,
    )

    // Run 35063381969, attempt 3: wait starts 06:43:33.014,
    // publication completes 06:43:44.835. Replay the wait boundary;
    // AWS and network delivery are replaced by the received-event callback.
    jest.advanceTimersByTime(11_821)
    state.events.push({ data: todoEvent })
    state.eventNotifier?.()

    expect(await outcome).toBe("received")
    expect(state.eventNotifier).toBeNull()
  })

  it("keeps the Cucumber process step waiting beyond its old 25-second override", async () => {
    const world = createWorld()
    const state = world.userSessions.get("user")?.subscriptions.process
    if (!state) throw new Error("Missing test subscription")
    const step = support.stepDefinitions.find((definition) =>
      definition.matchesStepName(
        '"user" should see a process update for "Purchase Request" with 1 active instance',
      ),
    )
    if (!step) throw new Error("Missing process step")
    const outcome = Promise.resolve(
      step.code.call(world, "user", "Purchase Request", "1"),
    ).then(
      () => "received",
      (error: unknown) => error,
    )
    jest.advanceTimersByTime(30_000)
    state.events.push({
      data: {
        streamProcess: {
          documents: [
            {
              id: "process",
              name: "Purchase Request",
              activeInstances: 1,
              deleted: false,
            },
          ],
        },
      },
    })
    state.eventNotifier?.()
    expect(await outcome).toBe("received")
    expect(step.options.timeout).toBeGreaterThan(60_000)
  })

  it("still fails when no notification arrives within the deployed budget", async () => {
    const world = createWorld()
    const outcome = world
      .waitForUserTodoWithSummary(
        "user",
        "Approve expensive purchase request",
        "What",
        "Laptop for 2500",
      )
      .catch((error: unknown) => error)
    jest.advanceTimersByTime(60_000)
    expect(await outcome).toBeInstanceOf(Error)
    expect(
      world.userSessions.get("user")?.subscriptions.todo?.eventNotifier,
    ).toBeNull()
  })

  it("retains the short local timeout and honors an explicit caller deadline", async () => {
    delete process.env["APPSYNC_EVENTS_HTTP_HOST"]
    const world = createWorld()
    const local = world
      .waitForUserTodoStep("user", "missing")
      .catch((error: unknown) => error)
    jest.advanceTimersByTime(10_000)
    expect(await local).toBeInstanceOf(Error)

    process.env["APPSYNC_EVENTS_HTTP_HOST"] = "deployed-test"
    const explicit = world
      .waitForUserTodoStep("user", "missing", 500)
      .catch((error: unknown) => error)
    jest.advanceTimersByTime(500)
    expect(await explicit).toBeInstanceOf(Error)
  })

  it("accepts an already-received event without waiting for the deadline", async () => {
    const world = createWorld()
    const state = world.userSessions.get("user")?.subscriptions.todo
    if (!state) throw new Error("Missing test subscription")
    state.events.push({ data: todoEvent })
    await world.waitForUserTodoWithSummary(
      "user",
      "Approve expensive purchase request",
      "What",
      "Laptop for 2500",
    )
    expect(state.eventNotifier).toBeNull()
  })
})
