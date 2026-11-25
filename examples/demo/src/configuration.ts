import { configurationField } from "@processfocus/runtime"
import { Config } from "effect"
import { hostedCiFields } from "./hosted-ci"

// These definitions are shared by organisation construction and deployment preflight.
export const demoConfiguration = {
  owner: "Demo",
  target: "organisation",
  fields: {
    ...hostedCiFields,
    skipDelays: configurationField(
      "E2E_SKIP_DELAYS",
      Config.Boolean("E2E_SKIP_DELAYS").pipe(Config.withDefault(false)),
    ),
    googleClientId: configurationField(
      "GOOGLE_CLIENT_ID",
      Config.String("GOOGLE_CLIENT_ID"),
    ),
    googleClientSecret: configurationField(
      "GOOGLE_CLIENT_SECRET",
      Config.String("GOOGLE_CLIENT_SECRET"),
      { secret: true },
    ),
    ciPipelineSecret: configurationField(
      "CI_PIPELINE_SECRET",
      Config.option(Config.String("CI_PIPELINE_SECRET")),
      { secret: true },
    ),
    adminEmail: configurationField(
      "MY_EMAIL",
      Config.String("MY_EMAIL").pipe(Config.withDefault("test@example.com")),
    ),
    passkeyEmail: configurationField(
      "RESEND_REROUTE_EMAIL",
      Config.String("RESEND_REROUTE_EMAIL").pipe(
        Config.withDefault("passkey@example.com"),
      ),
    ),
  },
  rules: [],
}
