import { DateTime, Duration, Effect, Option } from "effect"
import { AuthenticationDatabase } from "../authentication-database.js"
import { InvariantViolationError } from "../invariant-violation-error.js"
import { withM2MUpsertRetry } from "../non-critical-retry.js"
import type { SuccessResult } from "./types.js"

/**
 * Serialize object to JSON for HTTP response body.
 * Uses globalThis.JSON to bypass Effect language service diagnostic.
 */
const toJsonBody = (obj: unknown): string => globalThis.JSON.stringify(obj)

/**
 * Value passed to the success handler for M2M client credentials authentication.
 */
export interface CredentialsValue {
  readonly provider: "credentials"
  readonly clientID: string
  readonly scope?: string
}

/**
 * Handle M2M client credentials authentication success
 *
 * An optional `role:RolePath` scope selects a prepared machine role.
 *
 * Note: Transaction handling is done by the caller in create-authentication-server.ts
 */
export const handleConfidentialClientSuccess = (
  value: CredentialsValue,
): Effect.Effect<SuccessResult, unknown, AuthenticationDatabase> =>
  Effect.gen(function* () {
    const requestedRoles: string[] = []
    const scopes = value.scope?.split(/\s+/) ?? []
    if (scopes.some((part) => part.startsWith("email:"))) {
      return new Response(
        toJsonBody({
          error: "invalid_scope",
          error_description:
            "Machine credentials cannot authenticate as a Provider User",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      )
    }
    for (const part of scopes) {
      if (part.startsWith("role:")) {
        requestedRoles.push(decodeURIComponent(part.slice(5)))
      }
    }
    return yield* handleM2MUserToken(value.clientID, requestedRoles)
  })

/**
 * Handle standard M2M user token generation (no email scope).
 *
 * For role requests:
 * - Only one role can be requested at a time
 * - The role must be pre-authorized via the requestRole GraphQL mutation
 * - The permission must be less than 10 minutes old
 */
export const handleM2MUserToken = (
  clientId: string,
  requestedRoles: string[],
): Effect.Effect<SuccessResult, unknown, AuthenticationDatabase> =>
  Effect.gen(function* () {
    const authDb = yield* AuthenticationDatabase

    let roles: string[] = []
    let orgUnitId: string | undefined
    let orgUnitPath: string | undefined

    if (requestedRoles.length > 1) {
      // Only one role allowed for M2M without email scope
      yield* Effect.logWarning(
        "M2M client requested multiple roles (only one allowed)",
      ).pipe(
        Effect.annotateLogs({
          clientId,
          requestedRoles,
        }),
      )
      return new Response(
        toJsonBody({
          error: "invalid_scope",
          error_description: "Only one role can be requested at a time",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      )
    }

    if (requestedRoles.length === 1) {
      const requestedRole = requestedRoles[0]
      if (!requestedRole) {
        return yield* new InvariantViolationError({
          message: "Invariant violation: requestedRole is null",
        })
      }

      const permittedRoleOpt = yield* authDb.findPermittedClientRole(
        clientId,
        requestedRole,
      )

      if (Option.isNone(permittedRoleOpt)) {
        yield* Effect.logWarning(
          "M2M client requested role without permission",
        ).pipe(
          Effect.annotateLogs({
            clientId,
            requestedRole,
          }),
        )
        return new Response(
          toJsonBody({
            error: "invalid_scope",
            error_description:
              "Role not permitted. Call requestRole mutation first.",
          }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        )
      }

      const permittedRole = permittedRoleOpt.value

      // Check 10-minute expiry window
      const now = yield* DateTime.now
      const ageMs = Duration.toMillis(
        DateTime.distance(permittedRole.updatedAt, now),
      )
      const maxAgeMs = Duration.toMillis(Duration.minutes(10))
      if (ageMs > maxAgeMs) {
        yield* Effect.logWarning("M2M client role permission expired").pipe(
          Effect.annotateLogs({
            clientId,
            requestedRole,
            permissionUpdatedAt: permittedRole.updatedAt,
          }),
        )
        return new Response(
          toJsonBody({
            error: "invalid_scope",
            error_description:
              "Role permission expired. Call requestRole mutation again.",
          }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        )
      }

      // Use the permitted role's org unit
      roles = [permittedRole.rolePath]
      orgUnitId = permittedRole.orgUnitId
      orgUnitPath = permittedRole.orgUnitPath
    }

    // Find or create the machine identity without recording human login evidence.
    const now = yield* DateTime.now
    const userId = yield* withM2MUpsertRetry(
      authDb.upsertM2MUser(clientId, now),
    )

    yield* Effect.log("M2M client authenticated").pipe(
      Effect.annotateLogs({
        provider: "credentials",
        clientId,
        userId,
        roles,
        orgUnitId,
        orgUnitPath,
      }),
    )

    // For M2M clients, we use the database user ID
    // Roles are granted based on permitted_client_role (pre-authorized via Cedar)
    // orgUnitPath is derived from the permitted role for authorization
    return {
      type: "user" as const,
      properties: {
        userId,
        clientId,
        roles,
        orgUnitId,
        orgUnitPath,
      },
    }
  })
