# @processfocus/plugin-posthog

Org-scoped PostHog opt-in for Process Focus.

This package provides:

- `PostHog`
- `postHogFrontendClientPlugin`

The construct enables PostHog for an org at module scope and exposes the
public browser config through the generic frontend client plugin manifest.
The browser runtime stays in this package too, exposed as a frontend client
plugin registration.

## Installation

This package is part of the workspace. Add it to your org dependencies:

```json
{
  "dependencies": {
    "@processfocus/plugin-posthog": "0.1.0-next.2"
  }
}
```

## Usage

Add PostHog to the plain module-scope `org` export:

```ts
import { Config } from "effect"
import { PostHog } from "@processfocus/plugin-posthog"
import { Organisation } from "processfocus"

export const org = new Organisation({
  name: "Example Org",
})

new PostHog(org, "posthog", {
  apiKey: Config.string("SCHOOL_POSTHOG_PROJECT_TOKEN"),
  host: "https://us.i.posthog.com",
})
```

`apiKey` may be passed as a plain string or an `Effect.Config<string>`.
Using `Config.string(...)` keeps the plain module-scope org explicit while still
letting `pfcli build` resolve the value from environment config.

Both values are public browser config values. They are expected to be embedded
into the generated frontend artifact.

## What `pfcli build` does

When `PostHog` is present, `pfcli build` includes it in
`dist/frontend-manifest.json` via the plugin's own manifest provider.

Disabled orgs get:

```json
{
  "version": 1,
  "embed": { "entries": [] },
  "plugins": {
    "analytics": [],
    "formComponents": []
  }
}
```

Enabled orgs get:

```json
{
  "version": 1,
  "embed": { "entries": [] },
  "plugins": {
    "analytics": [
      {
        "type": "analytics.posthog",
        "config": {
          "apiKey": "phc_your_project_api_key",
          "host": "https://us.i.posthog.com"
        }
      }
    ],
    "formComponents": []
  }
}
```

## Notes

- The construct must be declared from the plain module-scope `org` export.
- Public PostHog config currently lives on the construct in `org.ts`.
- Frontend runtime initialization is handled by the exported client plugin in
  this package, not by `apps/frontend` directly.

## Testing

```bash
bun scripts/nx-quiet.ts run @processfocus/plugin-posthog:test
```
