# @pf/realtime-client

Shared AppSync Events connection and subscription-presence handling for browser
and CLI clients.

It manages connection recovery and subscription leases. Applications supply
resolved endpoints, credentials, session checks, and callbacks for received data.

Endpoint resolution lives in
[`@pf/frontend-endpoints`](../frontend-endpoints/README.md).
See [subscription presence](../../docs/realtime/subscription-presence.md) for
the lifecycle.
