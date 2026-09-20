"use server"

import { getFrontendJwt } from "@pf/auth-session"
import { emptyEvalResult, evaluateWithArtifacts } from "./cedar-authorize"
import type {
  AuthorizationEvalInput,
  AuthorizationEvalResult,
} from "./cedar-types"
import { getSessionWithTokenAndExpiry } from "@/lib/auth/session"
import { getFeaturePermissions } from "@/lib/effect/services"
import { fetchCedarPolicies } from "@/lib/graphql/queries"
import { createServerGraphqlClient } from "@/lib/graphql/server-client"

export const evaluateAuthorizationCedar = async (
  input: AuthorizationEvalInput,
): Promise<AuthorizationEvalResult> => {
  const session = await getSessionWithTokenAndExpiry()
  if (!session || !("email" in session)) {
    return emptyEvalResult(input, ["Not authorised"])
  }
  const permissions = await getFeaturePermissions(session)
  if (!permissions.viewAuthorization) {
    return emptyEvalResult(input, ["Not authorised"])
  }

  const token = getFrontendJwt()
  if (!token) {
    return emptyEvalResult(input, ["FRONTEND_JWT_TOKEN is not configured"])
  }

  const client = createServerGraphqlClient(token)
  const data = await fetchCedarPolicies(client)
  if (!data) {
    return emptyEvalResult(input, ["cedarPolicies query returned no data"])
  }

  return evaluateWithArtifacts(
    data.policies.join("\n\n"),
    data.schema,
    input,
    true,
  )
}
