import { Context, Effect, Layer } from "effect"
import { AuthorizationService, DelegationPrincipal } from "@pf/auth-policy"
import { RequestTime } from "@pf/request-time"
import {
  type DelegationCredentialService,
  InvalidDelegationSession,
  makeDelegationCredentialChecker,
  makeDelegationExchange,
} from "./delegation-credential"
import { DelegationDatabase } from "./delegation-database"
import { DelegationIdentityFacts } from "./delegation-identity-facts"

export {
  type DelegatedSession,
  InvalidDelegationSession,
} from "./delegation-credential"

/** Authorized application acceptance, distinct from issuer credential validity. */
export class DelegationSessionService extends Context.Service<
  DelegationSessionService,
  Context.Service.Shape<typeof DelegationCredentialService>
>()("@pf/delegation/DelegationSessionService") {}

export const makeDelegationSessionChecker = ({
  db,
  authDb,
  auth,
}: {
  readonly db: Context.Service.Shape<typeof DelegationDatabase>
  readonly authDb: Context.Service.Shape<typeof DelegationIdentityFacts>
  readonly auth: Context.Service.Shape<typeof AuthorizationService>
}): Context.Service.Shape<typeof DelegationSessionService>["check"] =>
  makeDelegationCredentialChecker({
    db,
    authDb,
    acceptOwner: (facts, now) =>
      Effect.gen(function* () {
        if (
          !(yield* auth
            .canLogin(new DelegationPrincipal(facts.id, facts), {
              uid: { type: "PF::Application", id: "frontend" },
            })
            .pipe(Effect.provideService(RequestTime, now)))
        )
          return yield* new InvalidDelegationSession()
      }).pipe(Effect.mapError(() => new InvalidDelegationSession())),
  })

export const DelegationSessionServiceIsolated = Layer.effect(
  DelegationSessionService,
  Effect.gen(function* () {
    const db = yield* DelegationDatabase
    const authDb = yield* DelegationIdentityFacts
    const auth = yield* AuthorizationService
    return yield* makeDelegationExchange(
      makeDelegationSessionChecker({ db, authDb, auth }),
    )
  }),
)
