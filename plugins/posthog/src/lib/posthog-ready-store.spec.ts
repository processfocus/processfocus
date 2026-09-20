import {
  getPostHogReadySnapshot,
  setPostHogReady,
  subscribeToPostHogReady,
} from "./posthog-ready-store"
import { afterEach, beforeEach, describe, expect, it } from "bun:test"

describe("posthog-ready-store", () => {
  beforeEach(() => {
    setPostHogReady(false)
  })

  afterEach(() => {
    setPostHogReady(false)
  })

  it("returns false by default", () => {
    expect(getPostHogReadySnapshot()).toBe(false)
  })

  it("queues listener and fires on transition to true", () => {
    const calls: number[] = []
    subscribeToPostHogReady(() => {
      calls.push(1)
    })

    expect(calls).toEqual([])

    setPostHogReady(true)

    expect(calls).toEqual([1])
  })

  it("does not refire listener on duplicate true transition", () => {
    const calls: number[] = []
    subscribeToPostHogReady(() => {
      calls.push(1)
    })

    setPostHogReady(true)
    setPostHogReady(true)

    expect(calls).toEqual([1])
  })

  it("allows unsubscribing a queued listener", () => {
    const calls: number[] = []
    const unsubscribe = subscribeToPostHogReady(() => {
      calls.push(1)
    })

    unsubscribe()
    setPostHogReady(true)

    expect(calls).toEqual([])
  })

  it("allows unsubscribing after the listener has fired", () => {
    const calls: number[] = []
    const unsubscribe = subscribeToPostHogReady(() => {
      calls.push(1)
    })

    setPostHogReady(true)

    expect(calls).toEqual([1])

    unsubscribe()
    setPostHogReady(false)
    setPostHogReady(true)

    expect(calls).toEqual([1])
  })
})
