import { Context, Layer } from "effect"

export interface NotificationSenderIdentity {
  readonly email: string
  readonly name?: string | undefined
}

/**
 * Runtime config needed to build notification deep links.
 */
export class NotificationDeliveryConfig extends Context.Tag(
  "@pf/job-handler/NotificationDeliveryConfig",
)<
  NotificationDeliveryConfig,
  {
    readonly getFrontendBaseUrl: () => string
    readonly getSenderIdentity: () => NotificationSenderIdentity | undefined
    readonly getEnvironment: () => string | undefined
  }
>() {}

export const makeNotificationDeliveryConfig = (
  getFrontendBaseUrl: () => string,
  getEnvironment: () => string | undefined = () => process.env["PF_ENV"],
): Layer.Layer<NotificationDeliveryConfig, never, never> =>
  Layer.succeed(NotificationDeliveryConfig, {
    getFrontendBaseUrl,
    getSenderIdentity: () => undefined,
    getEnvironment,
  })
