import { Effect } from "effect"
import type {
  ProviderUserSession,
  ServiceAccountSession,
  Session,
} from "@pf/auth-session"
import { NotAuthorized } from "@pf/graphql-schema"
import { delegatedRealtimeEnabled } from "./delegated-realtime"

/** Presence is enough to prohibit fallback, including malformed delegation facts. */
export const hasDelegation = (props: Session | undefined): boolean =>
  props !== undefined && "delegation" in props

export const rejectUnsupportedDelegationHandoff = (
  props: Session | undefined,
  operation: string,
): Effect.Effect<void, NotAuthorized> =>
  Effect.gen(function* () {
    if (props && "awsRole" in props)
      return yield* new NotAuthorized({
        action: operation,
        resource: "AWS request identity",
        message: "AWS request identity cannot acquire transferable credentials",
      })
    if (
      props?.workload &&
      operation !== "subscriptionTransport" &&
      operation !== "requestDatabaseUploadUrl" &&
      operation !== "requestUploadUrl" &&
      operation !== "file upload" &&
      operation !== "database transfer"
    )
      return yield* new NotAuthorized({
        action: operation,
        resource: "Workload handoff",
        message: "Workload capability handoff is unavailable",
      })
    if (!hasDelegation(props)) return
    if (
      operation === "subscriptionTransport" &&
      (yield* delegatedRealtimeEnabled)
    )
      return
    return yield* new NotAuthorized({
      action: operation,
      resource: "Delegation handoff readiness",
      message: `Delegated ${operation} is not available until its bounded handoff is implemented`,
    })
  })

export const isProviderUserSession = (
  props: Session | undefined,
): props is ProviderUserSession => {
  return props !== undefined && "email" in props
}

export const isServiceAccountSession = (
  props: Session | undefined,
): props is ServiceAccountSession => {
  return props !== undefined && "clientId" in props
}
