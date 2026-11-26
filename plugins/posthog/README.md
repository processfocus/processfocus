# @processfocus/plugin-posthog

Adds opt-in PostHog analytics to an organisation's frontend.

## Setup

Declare the plugin alongside your organisation and include its configuration:

```ts
import { PostHog, makePostHogConfiguration } from "@processfocus/plugin-posthog"

const posthog = makePostHogConfiguration()
new PostHog(org, "posthog", { configuration: posthog })
export const Configuration = { version: 1, groups: [posthog] }
```

Set `POSTHOG_PROJECT_API_KEY` to your public project token and `POSTHOG_HOST` to
your ingestion URL. These values are browser-visible.

An absent token disables analytics. Analytics is also disabled by default when
`NODE_ENV=development`. `makePostHogConfiguration` supports custom key bindings,
a fixed host and explicit enablement.

Build and deploy the organisation to include its analytics configuration.
