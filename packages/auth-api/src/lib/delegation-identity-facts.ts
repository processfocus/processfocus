import { Effect, Layer, Option } from "effect"
import {
  DelegationIdentityFacts,
  mapDelegationQueryError,
} from "@pf/delegation"
import { AuthenticationDatabase } from "./authentication-database.js"

/** Adapt existing queries without capturing identity state or changing transaction timing. */
export const AuthenticationDelegationIdentityFactsLive = Layer.effect(
  DelegationIdentityFacts,
  Effect.gen(function* () {
    const db = yield* AuthenticationDatabase
    return DelegationIdentityFacts.of({
      findProviderUserByUserId: (userId) =>
        db
          .findProviderUserByUserId(userId)
          .pipe(mapDelegationQueryError("Failed to find Delegation owner")),
      findProviderUserRoles: (userId) =>
        db
          .findProviderUserRoles(userId)
          .pipe(
            mapDelegationQueryError("Failed to find Delegation owner roles"),
          ),
      isPasskeyAvailable: () =>
        db
          .findOAuthProviderByName("passkey")
          .pipe(
            Effect.map(Option.isSome),
            mapDelegationQueryError("Failed to find passkey availability"),
          ),
    })
  }),
)
