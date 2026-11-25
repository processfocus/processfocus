# @processfocus/plugin-resend

Sends email from Process Focus processes through Resend, with optional
webhook-based delivery tracking.

## Setup

Verify your sending domain in Resend and add the server plugin to your
organisation:

```ts
import { ResendServerPlugin } from "@processfocus/plugin-resend/runtime"

export const ServerPlugins = [ResendServerPlugin]
```

Configure these runtime values:

| Setting | Purpose |
| --- | --- |
| `RESEND_API_KEY` | Secret Resend sending key |
| `RESEND_ENABLED` | `true` sends to intended recipients; defaults to `false` |
| `RESEND_REROUTE_EMAIL` | Required destination when delivery is rerouted |
| `RESEND_WAIT_FOR_DELIVERY` | Wait for delivery confirmation; defaults to `true` |
| `RESEND_WEBHOOK_SECRET` | Secret signing key, required when waiting for delivery |

Rerouted delivery still sends real email, but sends it to the configured inbox
and omits CC/BCC. Store hosted secrets with `pfcli config set --secret` and
redeploy after configuration changes.

## Send from a process

```ts
import { Effect } from "effect"
import { ResendStep } from "@processfocus/plugin-resend"

const sendConfirmation = new ResendStep(flow, "Send confirmation", {
  from: "Operations <noreply@example.com>",
  input: (state) => Effect.succeed({
    to: [state.email],
    subject: "Request approved",
    text: "Your request has been approved.",
  }),
})
```

Use a sender on your verified domain. The step returns the provider's `emailId`.
System notifications use the organisation's separately configured sender.

## Delivery completion policy

By default, email steps wait for a signed delivery or failure webhook. Register
`https://<your-dashboard-domain>/webhooks/resend` in Resend and subscribe to:

- `email.delivered`
- `email.bounced`
- `email.failed`
- `email.suppressed`

Delivery completes the step; the other events fail it. An unreachable webhook
leaves steps waiting, including rerouted messages.

For environments without callbacks, set `RESEND_WAIT_FOR_DELIVERY=false`.
Steps then complete when Resend accepts the message, which is not confirmation
of mailbox delivery. This mode needs no webhook secret. Organisations can
provide a different default through `makeResendServerPlugin`; explicit
configuration takes precedence.

## Development

`@processfocus/plugin-resend/test-support` provides `makeMockResendPlugin` for
capturing messages and exercising delivery callbacks without sending email.
