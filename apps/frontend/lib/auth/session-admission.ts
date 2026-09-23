import { FetchHttpClient } from "@effect/platform"
import { Config, Effect, Option } from "effect"
import { makeProjectBalanceAdmission } from "@pf/aws-common"

/** Only hosted customer deployments supply this configuration. Never cache admission. */
export const admitsNewSession = (): Promise<boolean> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const origin = yield* Config.option(
        Config.string("PF_PROJECT_BALANCE_BACKEND_ORIGIN"),
      )
      if (Option.isNone(origin)) return true
      const projectId = yield* Config.string("PF_PROJECT_BALANCE_PROJECT_ID")
      const credential = yield* Config.redacted("PF_PROJECT_BALANCE_CREDENTIAL")
      const admission = yield* makeProjectBalanceAdmission({
        backendOrigin: origin.value,
        projectId,
        credential,
      })
      return yield* admission.admits
    }).pipe(
      Effect.catchAll(() =>
        Effect.logWarning(
          "Project Balance could not be read; admitting login",
        ).pipe(Effect.as(true)),
      ),
      Effect.provide(FetchHttpClient.layer),
    ),
  )
