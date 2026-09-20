import { Effect } from "effect"
import {
  decodeResendWebhookPayload,
  makeResendWebhookHeaders,
  parseResendWebhookEvent,
  verifyResendWebhookSignature,
} from "./resend-webhook-event"
import { describe, expect, it } from "bun:test"

const webhookSecret = "whsec_dGVzdF9yZXNlbmRfd2ViaG9va19zZWNyZXQ="

const parseEvent = async (body: string) => {
  const payload = await Effect.runPromise(decodeResendWebhookPayload(body))
  return parseResendWebhookEvent({ deliveryId: "msg-test", payload })
}

describe("Resend webhook events", () => {
  it("shares signing and verification outside the AWS runtime", () => {
    const payload = JSON.stringify({ type: "email.delivered" })
    const headers = makeResendWebhookHeaders({
      payload,
      webhookSecret,
      deliveryId: "msg-test",
      timestamp: "1767225600",
    })

    expect(
      verifyResendWebhookSignature({
        payload,
        headers,
        webhookSecret,
        now: 1_767_225_600_000,
      }),
    ).toBe(true)
  })

  it("classifies recipient-address failures", async () => {
    const event = await parseEvent(
      JSON.stringify({
        type: "email.failed",
        data: {
          email_id: "email-123",
          to: ["external@example.com"],
          tags: {
            pf_public_completion_todo_id: "todo-123",
            pf_public_completion_environment: "dev",
            pf_public_completion_invitation_attempt_id: "pcia-123",
          },
          failed: {
            recipient: "external@example.com",
            reason: "recipient_not_found",
          },
        },
      }),
    )

    expect(event.publicCompletion).toEqual({
      todoId: "todo-123",
      environment: "dev",
      invitationAttemptId: "pcia-123",
    })
    expect(event.failure?.failureKind).toBe("recipient_address")
    expect(event.failure?.details).toMatchObject({
      failureReasonDetail: "recipient_not_found",
    })
  })

  it("classifies provider transport failures", async () => {
    const event = await parseEvent(
      JSON.stringify({
        type: "email.failed",
        data: {
          to: ["external@example.com"],
          tags: {
            pf_public_completion_todo_id: "todo-123",
            pf_public_completion_environment: "dev",
            pf_public_completion_invitation_attempt_id: "pcia-123",
          },
          failed: {
            recipient: "external@example.com",
            reason: "provider_timeout",
          },
        },
      }),
    )

    expect(event.failure?.failureKind).toBe("provider_transport")
  })

  it("prioritizes structured failed reasons over fallback detail scanning", async () => {
    const event = await parseEvent(
      JSON.stringify({
        type: "email.failed",
        data: {
          to: ["external@example.com"],
          failed: {
            recipient: "suppressed",
            reason: "provider_timeout",
          },
        },
      }),
    )

    expect(event.failure?.failureKind).toBe("provider_transport")
  })
})
