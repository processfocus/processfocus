import { Schema } from "effect"
import { ProviderUserSessionSchema } from "./subjects"

export const PROJECT_SUBSCRIPTION_AUDIENCE = "console-project-subscription"
export const PROJECT_SUBSCRIPTION_PURPOSE = "subscribe-projects"
export const ProjectSubscriptionTicket = Schema.Struct({
  aud: Schema.Literal(PROJECT_SUBSCRIPTION_AUDIENCE),
  purpose: Schema.Literal(PROJECT_SUBSCRIPTION_PURPOSE),
  type: Schema.Literal("projectSubscription"),
  exp: Schema.Number,
  recipientId: Schema.String,
  properties: ProviderUserSessionSchema,
})
