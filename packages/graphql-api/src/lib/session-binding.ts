import { GraphQLError } from "graphql"
import type { Session } from "@pf/auth-session"
import { getSessionCacheScope } from "@pf/auth-session/session-cache-scope"

/** Bind cached clients to the verified credential, never to the current cookie jar. */
export function assertGraphqlSessionBinding(
  context: Record<string, unknown>,
  session: Session | undefined,
): void {
  const mismatch = () =>
    new GraphQLError("Session cache scope changed", {
      extensions: { code: "SESSION_SCOPE_CHANGED" },
    })
  const assertScope = (expected: unknown) => {
    if (
      typeof expected !== "string" ||
      !session ||
      expected !== getSessionCacheScope(session)
    ) {
      throw mismatch()
    }
  }
  const params = context["connectionParams"]
  if (
    typeof params === "object" &&
    params !== null &&
    "sessionCacheScope" in params
  ) {
    assertScope(params.sessionCacheScope)
  }
  const request = context["request"]
  if (request instanceof Request) {
    const header = request.headers.get("x-pf-session-cache-scope")
    if (header !== null) {
      let scope: string
      try {
        scope = decodeURIComponent(header)
      } catch {
        throw mismatch()
      }
      assertScope(scope)
    }
  }
}
