# @processfocus/plugin-resend

Resend email plugin for Process Focus business processes. Provides a `ResendStep` system step that sends emails via the Resend API.

## Installation

This package is part of the workspace. Add it to your process dependencies:

```json
{
  "dependencies": {
    "@processfocus/plugin-resend": "0.1.0-next.2"
  }
}
```

## Configuration

Set the `RESEND_API_KEY` environment variable with your Resend API key.

### Deployed Environments

For cloud-hosted deployments, use `pfcli` to set the secret:

```bash
bun cli/pfcli/src/main.ts config set RESEND_API_KEY="re_xxxxxxxx" --project <project-id> --stage "<stage-name>" --secret
```

### Email Routing (Development/Staging)

To prevent sending emails to real recipients during development or staging:

- `RESEND_ENABLED` - Set to `"true"` to send emails to real recipients. Defaults to `"false"`.
- `RESEND_REROUTE_EMAIL` - When `RESEND_ENABLED` is not `"true"`, all emails are sent to this address instead. CC and BCC are ignored in this mode.

```bash
# Reroute all emails to a test inbox
bun cli/pfcli/src/main.ts config set RESEND_ENABLED="false" --project <project-id> --stage "Development"
bun cli/pfcli/src/main.ts config set RESEND_REROUTE_EMAIL="test@example.com" --project <project-id> --stage "Development" --secret

# Enable real email delivery for production
bun cli/pfcli/src/main.ts config set RESEND_ENABLED="true" --project <project-id> --stage "Production"
```

### System Notification Sender

`ResendStep` uses its own `from` prop, but platform notification emails need a
separate sender identity. These include task assignment notifications, public
form links, and fatal execution failure notifications.

Each organisation owns this sender configuration through its job-worker
`NotificationDeliveryConfig`. If an org uses Resend for notification delivery,
its custom job layer should provide:

- `EmailSender` backed by `ResendClient`.
- `NotificationDeliveryConfig` that reads `FRONTEND_BASE_URL`,
  `NOTIFICATION_SENDER_EMAIL`, and optionally `NOTIFICATION_SENDER_NAME`.

Configure those values with `pfcli config set`:

```bash
bun cli/pfcli/src/main.ts config set FRONTEND_BASE_URL="https://example.processfocus.com" --project <project-id> --stage "Production"
bun cli/pfcli/src/main.ts config set NOTIFICATION_SENDER_EMAIL="noreply@example.com" --project <project-id> --stage "Production"
bun cli/pfcli/src/main.ts config set NOTIFICATION_SENDER_NAME="Example School" --project <project-id> --stage "Production"
```

Redeploy the environment after changing stage config so the runtime receives the
new values.

`FRONTEND_BASE_URL` is required so notification emails can link back to tasks,
public forms, and executions. If it is missing, the job worker fails to start
with a configuration error. If `NOTIFICATION_SENDER_NAME` is omitted or empty,
the sender falls back to the raw email address.

If the sender email is missing, notification preferences may still enqueue a
notification job, but the job worker will skip delivery before calling Resend.
`NOTIFICATION_SENDER_EMAIL` must use a Resend-verified domain. `RESEND_API_KEY`
and `RESEND_ENABLED` must also be configured as described above, because
notification delivery still sends through Resend.

Example org wiring:

```typescript
import { Config, Effect, Layer, Option } from "effect"
import {
  type EmailMessage,
  EmailSender,
  NotificationDeliveryConfig,
  NotificationDeliverySendError,
} from "@processfocus/runtime"
import { ResendClient } from "@processfocus/plugin-resend"
import { ResendServerPlugin } from "@processfocus/plugin-resend/runtime"

// This executable org export opts both local and cloud runtime hosts into the
// Resend client, deferred-step behavior, and /webhooks/resend descriptor.
export const ServerPlugins = [ResendServerPlugin]

const NotificationEmailSenderLive = Layer.effect(
  EmailSender,
  Effect.gen(function* () {
    const resendClient = yield* ResendClient

    return {
      send: (message: EmailMessage) =>
        resendClient
          .sendEmail({
            to: message.to,
            from: message.from,
            subject: message.subject,
            html: message.html,
          })
          .pipe(
            Effect.asVoid,
            Effect.mapError(
              (cause) =>
                new NotificationDeliverySendError({
                  recipientEmail: message.to,
                  message:
                    cause instanceof Error ? cause.message : String(cause),
                  cause,
                }),
            ),
          ),
    }
  }),
)

const NotificationDeliveryConfigLive = Layer.effect(
  NotificationDeliveryConfig,
  Effect.gen(function* () {
    const frontendBaseUrl = yield* Config.string("FRONTEND_BASE_URL")
    const senderEmail = yield* Config.option(
      Config.string("NOTIFICATION_SENDER_EMAIL"),
    )
    const senderName = yield* Config.option(
      Config.string("NOTIFICATION_SENDER_NAME"),
    )

    return {
      getFrontendBaseUrl: () => frontendBaseUrl,
      getSenderIdentity: () =>
        senderEmail.pipe(
          Option.match({
            onNone: () => undefined,
            onSome: (email) => ({
              email,
              ...(Option.isSome(senderName) && senderName.value.length > 0
                ? { name: senderName.value }
                : {}),
            }),
          }),
        ),
    }
  }),
)

// The registered server plugin supplies ResendClient to this org layer.
export const CustomJobLayer = Layer.mergeAll(
  NotificationDeliveryConfigLive,
  NotificationEmailSenderLive,
)
```

### Webhook Delivery Tracking

When the organisation exports `ResendServerPlugin`, local and cloud runtimes
use deferred completion. The process step is sent first, then stays pending
until Resend calls back with a terminal webhook event. Organisations without
that registration do not expose the Resend webhook or install Resend job
services.

Configure a Resend webhook for your deployed environment at:

- `https://<your-domain>/webhooks/resend`
- If you do not use a custom domain: `https://<env>.<project-id>.app.processfocus.com/webhooks/resend`

Subscribe the webhook to these Resend events:

- `email.bounced`
- `email.delivered`
- `email.failed`
- `email.suppressed`

Store the signing secret that Resend gives you as `RESEND_WEBHOOK_SECRET`:

```bash
pfcli config set RESEND_WEBHOOK_SECRET="whsec_xxxxxxxx" --project <project-id> --stage "<stage-name>" --secret
```

Notes:

- `email.delivered` completes the deferred step.
- `email.failed`, `email.bounced`, and `email.suppressed` fail the deferred step.
- If no webhook is configured, or `RESEND_WEBHOOK_SECRET` is missing, resend steps can remain running indefinitely.
- This still applies when `RESEND_ENABLED="false"` or `RESEND_REROUTE_EMAIL` is set. Rerouted emails are still tracked through Resend webhooks.

A typical resend payload:

```json
{
  "created_at": "2026-04-13T00:05:43.089Z",
  "data": {
    "created_at": "2026-04-13T00:05:42.051Z",
    "email_id": "5d405080-89b2-4465-8c6d-27d00a88ef91",
    "from": "ACME <noreply@example.com>",
    "subject": "Enrolment enquiry received",
    "tags": {
      "pf_environment": "test",
      "pf_todo_id": "todo-01KP22H0SM1NEW1031BZ9D3KN6"
    },
    "to": [
      "test@example.com"
    ]
  },
  "type": "email.delivered"
}
```

## Usage

```typescript
import { ResendStep } from "@processfocus/plugin-resend"

const sendConfirmation = new ResendStep(flow, "Send confirmation", {
  from: "Process Focus <noreply@processfocus.com>",
  input: (state) => Effect.succeed({
    to: [state.email],
    subject: "Your request has been approved",
    html: `<p>Hello ${state.name}, your request was approved.</p>`,
  }),
})
```

## ResendStep API

### Constructor Props

- `from: string` - Default sender address (e.g., `"Process Focus <noreply@processfocus.com>"`)
- `input` - Function mapping state to `ResendEmailInput`
- `name?`, `purpose?`, `phase?`, `sla?` - Standard step props

### ResendEmailInput

```typescript
interface ResendEmailInput {
  readonly to: string | readonly string[]
  readonly subject: string
  readonly html?: string
  readonly text?: string
  readonly from?: string       // overrides step's default
  readonly replyTo?: string | readonly string[]
  readonly cc?: string | readonly string[]
  readonly bcc?: string | readonly string[]
}
```

### Output

The step returns `{ emailId: string }` which is the Resend email ID.

## DNS Configuration

Configure the records supplied by Resend for your own sending domain:

- **DKIM**: `resend._domainkey` TXT record
- **MX**: `send` subdomain pointing to Amazon SES
- **SPF**: `send` subdomain TXT record
- **DMARC**: `_dmarc` TXT record

## Testing

```bash
bun scripts/nx-quiet.ts run @processfocus/plugin-resend:test
```

### Mock Resend Test Support

Tests can import `makeMockResendPlugin()` from
`@processfocus/plugin-resend/test-support`. It returns `{ layer, controller }`.

The layer provides:

- `ResendClient` for `ResendStep` sends.
- `ResendDeferredDelivery` for deferred `ResendStep.executeStep()` tests.
- `EmailSender` and `NotificationDeliveryConfig` for notification-delivery tests.

The controller lists captured messages, finds messages by provider email id,
Todo id, or Public Completion Invitation Attempt id, and creates signed
Resend-style delivery, bounce, suppression, and recipient-failure callback
requests.

`controller.clear()` removes captured messages and resets mock email and delivery
id counters, so old ids can be reused after clearing.

Notification-delivery Tags used with `./testing` (`EmailSender`,
`NotificationDeliveryConfig`) come from `@processfocus/runtime`. The testing
entrypoint itself exports `makeMockResendPlugin` and is not re-exported from
the package root.

By default, captured message and webhook timestamps use the current clock. Pass
`now` to `makeMockResendPlugin()` or per-event timestamp overrides when tests
need deterministic fake-time assertions.

Mock sending is enabled by default so unit tests capture normal sends without
environment setup. Set `enabled: false` to exercise reroute behavior.

```typescript
import { Effect } from "effect"
import { makeMockResendPlugin } from "@processfocus/plugin-resend/test-support"
import { ResendClient } from "@processfocus/plugin-resend"

const resend = makeMockResendPlugin({ environment: "dev" })

const result = await Effect.runPromise(
  Effect.gen(function* () {
    const client = yield* ResendClient
    return yield* client.sendEmail({
      to: "external@example.com",
      from: "Process Focus <notifications@example.com>",
      subject: "Complete form",
      html: "<p>Please complete the form.</p>",
      tags: [{ name: "pf_todo_id", value: "todo-123" }],
    })
  }).pipe(Effect.provide(resend.layer)),
)

const delivered = resend.controller.emitDelivery(result.emailId)
// Pass `delivered.request` to the Resend webhook handler in integration tests.
```
