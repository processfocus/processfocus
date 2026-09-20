import { reportClientException } from "../lib/client-plugin-error-reporting"
import { describe, expect, test } from "bun:test"

describe("client plugin error reporting", () => {
  test("reports client exceptions to active plugins", () => {
    const calls: Array<{ error: Error; properties: unknown }> = []

    reportClientException(
      [
        {
          config: { enabled: true },
          registration: {
            captureClientException(_config, error, properties) {
              calls.push({ error, properties })
            },
            render() {
              return null
            },
            type: "analytics.posthog",
          },
        },
      ],
      new Error("Embedded form submit failed: Dummy GraphQL failure"),
      {
        embed_process_path: "/enrolment-enquiry",
        embed_response_status: 400,
        embed_step_path: "/enrolment-enquiry/Submit enquiry",
      },
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]?.error.message).toBe(
      "Embedded form submit failed: Dummy GraphQL failure",
    )
    expect(calls[0]?.properties).toEqual({
      embed_process_path: "/enrolment-enquiry",
      embed_response_status: 400,
      embed_step_path: "/enrolment-enquiry/Submit enquiry",
    })
  })

  test("isolates a failing plugin from the remaining reporters", () => {
    const reported: string[] = []

    reportClientException(
      [
        {
          config: {},
          registration: {
            type: "broken",
            render: () => null,
            captureClientException: () => {
              throw new Error("reporter failed")
            },
          },
        },
        {
          config: {},
          registration: {
            type: "healthy",
            render: () => null,
            captureClientException: () => reported.push("healthy"),
          },
        },
      ],
      new Error("application failure"),
    )

    expect(reported).toEqual(["healthy"])
  })
})
