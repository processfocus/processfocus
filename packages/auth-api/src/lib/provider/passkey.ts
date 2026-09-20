import { Clock, Effect } from "effect"
import type { PasskeyProperties, StorageService } from "@pf/openauth"
import type { AuthenticationDatabase } from "../authentication-database.js"
import {
  authenticateProviderUserByPasskey,
  registerProviderUserByPasskey,
} from "../passkey-auth.js"
import { type SuccessResult, optionalProviderUserPicture } from "./types.js"

/**
 * Handle passkey authentication success
 *
 * Passkey authentication provides email and userId directly (no tokenset).
 * Creates or finds the provider user and returns subject data for the token.
 *
 * Note: Transaction handling is done by the caller in create-authentication-server.ts
 */
export const handlePasskeySuccess = (
  value: PasskeyProperties,
): Effect.Effect<
  SuccessResult,
  unknown,
  AuthenticationDatabase | StorageService
> =>
  Effect.gen(function* () {
    const providerUser = yield* value.type === "registration"
      ? registerProviderUserByPasskey(value)
      : authenticateProviderUserByPasskey(value)

    yield* Effect.log("User logged in via passkey").pipe(
      Effect.annotateLogs({
        provider: providerUser.provider,
        sub: providerUser.sub,
        id: providerUser.id,
        email: providerUser.email,
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
        roles: providerUser.roles,
        humanSession: true,
        ...(value.type === "authentication"
          ? {
              humanAuthentication: {
                providerUserId: providerUser.id,
                authenticatedAt: yield* Clock.currentTimeMillis,
                method: "passkey" as const,
              },
            }
          : {}),
      },
    }
  })
