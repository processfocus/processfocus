import { PostHog } from "@processfocus/plugin-posthog"
import { shouldActivatePostHogFrontendClientPlugin } from "@processfocus/plugin-posthog/activation-policy"
import { organisationFrontendPlugin } from "@processfocus/plugin-posthog/client"
import { Organisation } from "processfocus"

const org = new Organisation({ name: "Plugin Fixture" })
const plugin = new PostHog(org, "posthog", {
  apiKey: "phc_fixture",
  host: "https://us.i.posthog.com",
  enabled: true,
})

organisationFrontendPlugin.activate({
  kind: "organisation-plugin-host",
  interfaceVersion: 1,
  analytics: { register: () => () => undefined },
  formRenderers: { register: () => () => undefined },
  executionMenu: { register: () => () => undefined },
  graphql: { ClientConsumer: () => null },
})

if (
  plugin.host !== "https://us.i.posthog.com" ||
  !shouldActivatePostHogFrontendClientPlugin({ enabled: true }, "production") ||
  organisationFrontendPlugin.id !== "analytics.posthog"
) {
  throw new Error("PostHog plugin public surfaces failed")
}
