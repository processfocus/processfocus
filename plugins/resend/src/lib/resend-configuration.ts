import {
  type ConfigurationGroup,
  configurationField,
  configurationSecret,
  configurationString,
} from "@processfocus/runtime"
import { Config, Option, Schema } from "effect"

export const makeResendConfiguration = (
  bindings: { readonly apiKey?: string } = {},
) =>
  ({
    owner: "email.resend",
    target: "job-worker",
    fields: {
      apiKey: configurationField(
        bindings.apiKey ?? "RESEND_API_KEY",
        configurationSecret(bindings.apiKey ?? "RESEND_API_KEY"),
        { secret: true },
      ),
      enabled: configurationField(
        "RESEND_ENABLED",
        Config.Boolean("RESEND_ENABLED").pipe(Config.withDefault(false)),
      ),
      rerouteEmail: configurationField(
        "RESEND_REROUTE_EMAIL",
        Config.schema(
          Schema.String.pipe(
            Schema.check(Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)),
          ),
          "RESEND_REROUTE_EMAIL",
        ).pipe(Config.option),
      ),
      environment: configurationField(
        "PF_ENV",
        Config.option(configurationString("PF_ENV")),
        { source: "platform" },
      ),
    },
    rules: [{ when: "enabled", equals: false, required: "rerouteEmail" }],
  }) satisfies ConfigurationGroup

export const ResendConfiguration = makeResendConfiguration()
export const makeResendDeferredDeliveryConfiguration = (
  waitForDeliveryDefault: Config.Config<boolean> = Config.succeed(true),
) =>
  ({
    owner: "email.resend",
    target: "job-worker",
    fields: {
      waitForDelivery: configurationField(
        "RESEND_WAIT_FOR_DELIVERY",
        Config.Boolean("RESEND_WAIT_FOR_DELIVERY").pipe(
          Config.option,
          Config.flatMap(
            Option.match({
              onNone: () => waitForDeliveryDefault,
              onSome: Config.succeed,
            }),
          ),
        ),
      ),
      environment: configurationField(
        "PF_ENV",
        configurationString("PF_ENV").pipe(Config.withDefault("local")),
        { source: "platform" },
      ),
    },
    rules: [],
  }) satisfies ConfigurationGroup

export const ResendDeferredDeliveryConfiguration =
  makeResendDeferredDeliveryConfiguration()

export const makeResendWebhookConfiguration = (
  delivery = ResendDeferredDeliveryConfiguration,
) =>
  ({
    owner: "email.resend",
    target: "webhook",
    fields: {
      webhookSecret: configurationField(
        "RESEND_WEBHOOK_SECRET",
        Config.option(configurationSecret("RESEND_WEBHOOK_SECRET")),
        { secret: true },
      ),
      environment: delivery.fields.environment,
      waitForDelivery: delivery.fields.waitForDelivery,
    },
    rules: [
      { when: "waitForDelivery", equals: true, required: "webhookSecret" },
    ],
  }) satisfies ConfigurationGroup

export const ResendWebhookConfiguration = makeResendWebhookConfiguration()
