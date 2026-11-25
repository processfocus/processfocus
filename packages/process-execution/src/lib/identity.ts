import type {
  ProviderUserSession,
  ServiceAccountSession,
  Session,
} from "@pf/auth-session"
import type { ProcessStartTrigger } from "@pf/business-metrics"

/** Identity already verified by the authentication owner; never permission. */
export interface ExecutionIdentity {
  readonly session: Session | undefined
  readonly userId: string | undefined
  readonly subject?: string
}

export const hasDelegation = (session: Session | undefined): boolean =>
  session !== undefined && "delegation" in session

export const isProviderUserSession = (
  session: Session | undefined,
): session is ProviderUserSession => session !== undefined && "email" in session

export const isServiceAccountSession = (
  session: Session | undefined,
): session is ServiceAccountSession =>
  session !== undefined && "clientId" in session

export const processStartTriggerForSession = (
  session: Session | undefined,
): ProcessStartTrigger =>
  isProviderUserSession(session) && !session.workload ? "human" : "automated"
