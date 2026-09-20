import { Effect, Option } from "effect"
import { DelegationSessionService } from "@pf/auth-api"
import { subjects } from "@pf/auth-session"
import { NotAuthorized } from "@pf/graphql-schema"
import { hasDelegation, isProviderUserSession } from "./session-guards"
import type { JWTPayload } from "./types"

/** Called after JWT signature, issuer, audience and expiry verification. */
export const acceptVerifiedGraphqlJwt = (
  jwt: JWTPayload | undefined,
): Effect.Effect<JWTPayload | undefined, NotAuthorized> =>
  Effect.gen(function* () {
    if (!hasDelegation(jwt?.properties)) return jwt
    const unavailable = () =>
      new NotAuthorized({
        action: "login",
        resource: "GraphQL",
        message: "Delegated access is unavailable or invalid",
      })
    if (
      jwt?.type !== "providerUser" ||
      !isProviderUserSession(jwt.properties)
    ) {
      return yield* unavailable()
    }
    const parsed = yield* Effect.promise(() =>
      Promise.resolve(
        subjects.providerUser["~standard"].validate(jwt.properties),
      ),
    )
    if (parsed.issues) return yield* unavailable()
    // No fallback layer: public activation awaits owner lifecycle and realtime.
    const service = yield* Effect.serviceOption(DelegationSessionService)
    if (Option.isNone(service)) return yield* unavailable()
    const properties = yield* service.value
      .check(parsed.value)
      .pipe(Effect.mapError(unavailable))
    if (jwt.exp * 1000 > properties.delegation.expiresAt)
      return yield* unavailable()
    return { ...jwt, properties }
  })
