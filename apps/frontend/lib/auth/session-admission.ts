import { Config, ConfigProvider, Effect, Option } from "effect"
import { FetchHttpClient } from "effect/http"
import { makeProjectBalanceAdmission } from "@pf/project-accounting/admission"

/** Only hosted customer deployments supply this configuration. Never cache admission. */
export const admitsNewSession = (): Promise<boolean> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const origin = yield* Config.option(
        Config.String("PF_PROJECT_BALANCE_BACKEND_ORIGIN"),
      )
      if (Option.isNone(origin)) return true
      const projectId = yield* Config.String("PF_PROJECT_BALANCE_PROJECT_ID")
      const credential = yield* Config.Redacted("PF_PROJECT_BALANCE_CREDENTIAL")
      const admission = yield* makeProjectBalanceAdmission({
        backendOrigin: origin.value,
        projectId,
        credential,
      })
      return yield* admission.admits
    }).pipe(
      Effect.catch(() =>
        Effect.logWarning(
          "Project Balance could not be read; admitting login",
        ).pipe(Effect.as(true)),
      ),
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv(),
      ),
    ),
  )
