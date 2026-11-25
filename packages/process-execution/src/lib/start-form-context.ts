import type { DateTime } from "effect"
import type { FlowContext } from "@pf/process"
import { type ExecutionIdentity, isProviderUserSession } from "./identity"

/** A start request has no execution or completed steps yet. Empty IDs mean not allocated. */
export const startFormContext = (
  context: ExecutionIdentity,
  requestTime: DateTime.Utc,
): FlowContext<Record<string, never>> => {
  const session = context.session
  const email = isProviderUserSession(session) ? session.email : ""
  return {
    process: {
      executionId: "",
      startedAt: requestTime,
      startStep: {
        user: { userId: context.userId ?? "", sub: context.subject ?? "" },
        providerUser: {
          id: "",
          name: email,
          firstName: "",
          lastName: "",
          email,
          picture: isProviderUserSession(session)
            ? (session.picture ?? "")
            : "",
        },
        completedAt: requestTime,
      },
    },
    step: {},
  }
}
