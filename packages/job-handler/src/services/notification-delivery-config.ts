import { NotificationDeliveryConfig } from "@processfocus/runtime"
import { Layer } from "effect"

export const makeNotificationDeliveryConfig = (
  getFrontendBaseUrl: () => string,
  getEnvironment: () => string | undefined = () => process.env["PF_ENV"],
): Layer.Layer<NotificationDeliveryConfig, never, never> =>
  Layer.succeed(NotificationDeliveryConfig, {
    getFrontendBaseUrl,
    getSenderIdentity: () => undefined,
    getEnvironment,
  })
