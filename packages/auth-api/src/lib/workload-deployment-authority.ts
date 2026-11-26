import { createHash } from "node:crypto"
import { Effect, Option } from "effect"
import type { ServiceAccountSession } from "@pf/auth-session"
import {
  AuthenticationDatabase,
  type DatabaseQueryError,
} from "./authentication-database"

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]),
    )
  return value
}

/** Bind deployment credentials to the trust and explicit grants that issued them. */
export const workloadDeploymentAuthorityVersion = (trust: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(canonical(trust)))
    .digest("hex")

/** Protected boundaries re-read authority; any grant/trust change requires fresh OIDC. */
export const checkWorkloadDeploymentAuthority = (
  session: Pick<ServiceAccountSession, "clientId" | "workload">,
): Effect.Effect<boolean, DatabaseQueryError, AuthenticationDatabase> =>
  Effect.gen(function* () {
    const version = session.workload?.deploymentAuthorityVersion
    if (!version) return false
    const db = yield* AuthenticationDatabase
    const client = yield* db.findOAuthClientById(session.clientId)
    return (
      Option.isSome(client) &&
      client.value.secretHash === "" &&
      client.value.workloadTrust !== undefined &&
      version === workloadDeploymentAuthorityVersion(client.value.workloadTrust)
    )
  })
