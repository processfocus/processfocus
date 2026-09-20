import { describe, expect, test, vi } from "vitest"
import {
  addImportCompletedSubscriber,
  publishImportCompleted,
} from "../lib/dev/import-completed-events"

describe("import completed events", () => {
  test("publishes import-completed payloads to subscribers", () => {
    const send = vi.fn()
    const unsubscribe = addImportCompletedSubscriber({ send })

    publishImportCompleted({ processPaths: ["/enrolment-enquiry"] })
    unsubscribe()

    expect(send).toHaveBeenCalledWith({
      processPaths: ["/enrolment-enquiry"],
    })
  })

  test("unsubscribes listeners from future import-completed payloads", () => {
    const subscribed = vi.fn()
    const unsubscribed = vi.fn()
    const unsubscribe = addImportCompletedSubscriber({ send: unsubscribed })
    const unsubscribeSubscribed = addImportCompletedSubscriber({
      send: subscribed,
    })

    unsubscribe()
    publishImportCompleted({ processPaths: ["/other-process"] })
    unsubscribeSubscribed()

    expect(unsubscribed).not.toHaveBeenCalled()
    expect(subscribed).toHaveBeenCalledWith({
      processPaths: ["/other-process"],
    })
  })
})
