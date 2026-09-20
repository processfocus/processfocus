import { DateTime, Duration, Effect, Option } from "effect"
import { AuthenticationDatabase } from "../authentication-database.js"
import { InvariantViolationError } from "../invariant-violation-error.js"
import { withM2MUpsertRetry } from "../non-critical-retry.js"
import { type SuccessResult, optionalProviderUserPicture } from "./types.js"

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
 * Supports two modes:
 * 1. With `email:` scope - generates a provider user token for the specified email
 * 2. Without `email:` scope - generates a user token for the M2M client
 *
 * Scopes are parsed from the scope parameter:
 * - `email:user@example.com` - act as provider user
 * - `role:RolePath` - request specific roles
 * - `org:/Sales` - specify org unit context
 *
 * Note: Transaction handling is done by the caller in create-authentication-server.ts
 */
export const handleConfidentialClientSuccess = (
  value: CredentialsValue,
): Effect.Effect<SuccessResult, unknown, AuthenticationDatabase> =>
  Effect.gen(function* () {
    // Parse scopes from the scope parameter
    const requestedRoles: string[] = []
    let requestedEmail: string | undefined

    if (value.scope) {
      const scopeParts = value.scope.split(/\s+/)
      for (const part of scopeParts) {
        if (part.startsWith("role:")) {
          requestedRoles.push(decodeURIComponent(part.slice(5)))
        } else if (part.startsWith("email:")) {
          requestedEmail = decodeURIComponent(part.slice(6))
        }
      }
    }

    // If email scope is present, generate a provider user token
    if (requestedEmail) {
      // For provider user tokens, we ignore any requested role scopes.
      // The provider user gets their default roles initially.
      // To switch roles, they must first get the provider user token,
      // then call the requestRole mutation.
      return yield* handleProviderUserToken(value.clientID, requestedEmail)
    }

    // No email scope - standard M2M user token flow
    return yield* handleM2MUserToken(value.clientID, requestedRoles)
  })

/**
 * Handle provider user token generation for M2M clients with email scope.
 */
const handleProviderUserToken = (
  clientId: string,
  requestedEmail: string,
): Effect.Effect<SuccessResult, unknown, AuthenticationDatabase> =>
  Effect.gen(function* () {
    const authDb = yield* AuthenticationDatabase

    // Check permitted_client_email
    const permittedEmailOpt = yield* authDb.findPermittedClientEmail(
      clientId,
      requestedEmail,
    )

    if (Option.isNone(permittedEmailOpt)) {
      yield* Effect.logWarning(
        "M2M client requested provider user token without permission",
      ).pipe(
        Effect.annotateLogs({
          clientId,
          requestedEmail,
        }),
      )
      return new Response(
        toJsonBody({
          error: "invalid_scope",
          error_description:
            "Email not permitted. Call requestProviderUserPermissions mutation first.",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      )
    }

    const permittedEmail = permittedEmailOpt.value

    // Check 10-minute expiry window
    const now = yield* DateTime.now
    const ageMs = DateTime.distance(permittedEmail.updatedAt, now)
    const maxAgeMs = Duration.toMillis(Duration.minutes(10))
    if (ageMs > maxAgeMs) {
      yield* Effect.logWarning(
        "M2M client provider user permission expired",
      ).pipe(
        Effect.annotateLogs({
          clientId,
          requestedEmail,
          permissionUpdatedAt: permittedEmail.updatedAt,
        }),
      )
      return new Response(
        toJsonBody({
          error: "invalid_scope",
          error_description:
            "Email permission expired. Call requestProviderUserPermissions mutation again.",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      )
    }

    // Look up the provider user by email
    const providerUserOpt =
      yield* authDb.findProviderUserByEmail(requestedEmail)

    if (Option.isNone(providerUserOpt)) {
      yield* Effect.logWarning(
        "M2M client requested provider user token for non-existent email",
      ).pipe(
        Effect.annotateLogs({
          clientId,
          requestedEmail,
        }),
      )
      return new Response(
        toJsonBody({
          error: "invalid_scope",
          error_description: `Provider user not found: ${requestedEmail}. Call requestProviderUserPermissions mutation first.`,
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      )
    }
    const providerUser = providerUserOpt.value

    // Determine roles: use provider user's default roles
    const roles = yield* authDb.findProviderUserRoles(providerUser.id)

    yield* Effect.log("M2M client authenticated as provider user").pipe(
      Effect.annotateLogs({
        provider: "credentials",
        clientId,
        providerUserEmail: requestedEmail,
        providerUserUserId: providerUser.id,
        orgUnitId: providerUser.orgUnitId,
        orgUnitPath: providerUser.orgUnitPath,
        roles,
      }),
    )

    return {
      type: "providerUser" as const,
      properties: {
        userId: providerUser.id,
        email: providerUser.email,
        picture: optionalProviderUserPicture(providerUser.picture),
        orgUnitId: providerUser.orgUnitId,
        orgUnitPath: providerUser.orgUnitPath,
        roles,
      },
    }
  })

/**
 * Handle standard M2M user token generation (no email scope).
 *
 * For role requests:
 * - Only one role can be requested at a time
 * - The role must be pre-authorized via the requestRole GraphQL mutation
 * - The permission must be less than 10 minutes old
 */
const handleM2MUserToken = (
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

      // Look up permitted_client_role
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
      const ageMs = DateTime.distance(permittedRole.updatedAt, now)
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

    // Create or update M2M user in the database. GraphQL e2e can skip the
    // hot-path last_logged_in update after the ci-pipeline user exists.
    const now = yield* DateTime.now
    const updateLastLoggedIn =
      process.env["PF_AUTH_SKIP_M2M_LAST_LOGGED_IN_UPDATE"] !== "true"
    const userId = yield* withM2MUpsertRetry(
      authDb.upsertM2MUser(clientId, now, { updateLastLoggedIn }),
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
