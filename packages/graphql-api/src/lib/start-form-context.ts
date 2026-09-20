import type { FlowContext } from "@pf/process"
import { isProviderUserSession } from "./session-guards"
import type { UserContext } from "./types"

/** A start request has no execution or completed steps yet. Empty IDs mean not allocated. */
export const startFormContext = (
  context: UserContext,
): FlowContext<Record<string, never>> => {
  const session = context.jwt?.properties
  const email = isProviderUserSession(session) ? session.email : ""
  return {
    process: {
      executionId: "",
      startedAt: context._requestTime,
      startStep: {
        user: { userId: context.userId ?? "", sub: context.jwt?.sub ?? "" },
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
        completedAt: context._requestTime,
      },
    },
    step: {},
  }
}
